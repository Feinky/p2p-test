let peer, connections = {}, myFiles = {}, remoteFiles = {};
const CHUNK_SIZE = 16384; 

async function joinMesh() {
    const room = document.getElementById('roomInput').value.trim();
    if (!room) return alert("Enter a room name");

    if (peer) peer.destroy();
    
    // Create a truly unique ID to avoid WebSocket "Already Taken" errors
    const myId = `TITAN-${room}-${Date.now()}`;
    
    peer = new Peer(myId, {
        host: '0.peerjs.com',
        port: 443,
        secure: true,
        debug: 1,
        config: {'iceServers': [{ 'urls': 'stun:stun.l.google.com:19302' }]}
    });

    peer.on('open', (id) => {
        updateStatus("ONLINE", true);
        console.log("My ID:", id);
        
        // Scan for Lobby slots 1-5
        for(let i=1; i<=5; i++) {
            const target = `TITAN-LOBBY-${room}-${i}`;
            if (id !== target) handleConn(peer.connect(target));
        }
        tryLobby(room, 1);
    });

    peer.on('connection', c => handleConn(c));
    
    peer.on('disconnected', () => peer.reconnect());
    
    peer.on('error', (err) => {
        if (err.type !== 'peer-unavailable') console.error("PeerJS:", err.type);
    });
}

function tryLobby(room, s) {
    if (s > 5) return;
    const lId = `TITAN-LOBBY-${room}-${s}`;
    const lPeer = new Peer(lId, { host: '0.peerjs.com', port: 443, secure: true });
    
    lPeer.on('open', () => lPeer.on('connection', c => handleConn(c)));
    lPeer.on('error', () => { lPeer.destroy(); tryLobby(room, s+1); });
}

function handleConn(c) {
    if (!c || connections[c.peer]) return;

    c.on('open', () => {
        connections[c.peer] = c;
        renderPeers();
        sync(c);
        
        // HEARTBEAT: Prevents GitHub/PeerJS from closing idle connections
        const hb = setInterval(() => {
            if (c.open) c.send({ type: 'hb' });
            else clearInterval(hb);
        }, 5000);
    });

    c.on('data', data => {
        if (data.type === 'hb') return; 
        if (data.type === 'list') { remoteFiles[c.peer] = data.files; renderRemote(); }
        if (data.type === 'req') upload(data.name, c);
        if (data.type === 'meta') download(data, c);
    });

    c.on('close', () => { 
        delete connections[c.peer]; 
        delete remoteFiles[c.peer]; 
        renderPeers();
        renderRemote();
    });
}

function renderPeers() {
    const gallery = document.getElementById('peerGallery');
    const countPill = document.getElementById('peerCount');
    const peers = Object.keys(connections);
    
    countPill.style.display = "block";
    countPill.innerText = `${peers.length} PEERS`;

    gallery.innerHTML = peers.map(pid => {
        const shortId = pid.split('-').pop().slice(-4);
        return `<div class="peer-card"><div class="status-dot"></div>ID: ...${shortId}</div>`;
    }).join('');
}

// --- FILE ENGINE ---

document.getElementById('fileInput').onchange = (e) => {
    for (let f of e.target.files) {
        myFiles[f.name] = f;
        document.getElementById('myList').innerHTML += `<div class="file-row"><span>${f.name}</span></div>`;
    }
    Object.values(connections).forEach(c => sync(c));
};

function sync(c) { 
    if (c?.open) c.send({ type: 'list', files: Object.values(myFiles).map(f => ({ name: f.name, size: f.size })) }); 
}

function renderRemote() {
    const ui = document.getElementById('peerList'); ui.innerHTML = "";
    Object.entries(remoteFiles).forEach(([pid, files]) => {
        files.forEach(f => {
            ui.innerHTML += `<div class="file-row">
                <span>${f.name} <small style="color:var(--p)">(${pid.split('-').pop().slice(-4)})</small></span>
                <button class="btn" style="padding:4px 10px; font-size:10px" onclick="connections['${pid}'].send({type:'req', name:'${f.name}'})">GET</button>
            </div>`;
        });
    });
}

async function upload(name, c) {
    const f = myFiles[name]; if (!f) return;
    const tid = Math.random().toString(36).substr(2, 5);
    const buf = await f.arrayBuffer();
    const hashBuffer = await crypto.subtle.digest('SHA-256', buf);
    const fileHash = Array.from(new Uint8Array(hashBuffer)).map(b => b.toString(16).padStart(2, '0')).join('');
    
    createRow(tid, f.name, 'SENDING');
    c.send({ type: 'meta', name: f.name, size: f.size, tid: tid, hash: fileHash });

    let off = 0;
    while (off < f.size) {
        if (!c.open) break;
        if (c.dataChannel.bufferedAmount > 1048576) { await new Promise(r => setTimeout(r, 50)); continue; }
        c.send(buf.slice(off, off + CHUNK_SIZE));
        off += CHUNK_SIZE;
        updateUI(tid, off, f.size);
    }
    if (c.open) setTimeout(() => c.send({ type: 'eof', tid: tid }), 500);
}

function download(meta, c) {
    createRow(meta.tid, meta.name, 'RECEIVING');
    let chunks = [];
    const handler = async (data) => {
        if (data.type === 'eof' && data.tid === meta.tid) {
            c.off('data', handler);
            finalize(meta.tid, meta.name, chunks, meta.hash);
            return;
        }
        if (data instanceof ArrayBuffer || data instanceof Uint8Array || data.byteLength !== undefined) {
            chunks.push(data);
            updateUI(meta.tid, chunks.reduce((a, b) => a + b.byteLength, 0), meta.size);
        }
    };
    c.on('data', handler);
}

async function finalize(tid, name, chunks, expectedHash) {
    const tag = document.getElementById(`tag-${tid}`);
    tag.innerText = "VERIFYING...";
    const blob = new Blob(chunks);
    const actualBuf = await blob.arrayBuffer();
    const hashBuffer = await crypto.subtle.digest('SHA-256', actualBuf);
    const actualHash = Array.from(new Uint8Array(hashBuffer)).map(b => b.toString(16).padStart(2, '0')).join('');

    if (actualHash !== expectedHash) {
        tag.innerText = "CORRUPT"; tag.style.color = "#ff4444";
    } else {
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a'); a.href = url; a.download = name; a.click();
        tag.innerText = "DONE"; tag.style.color = "#8bc34a";
    }
}

function createRow(id, name, type) {
    const html = `<div class="transfer-row" id="row-${id}">
        <div><div id="tag-${id}" style="font-size:9px; font-weight:bold; color:var(--p)">${type}</div><div style="font-size:11px;">${name}</div></div>
        <progress id="bar-${id}" value="0" max="100"></progress>
        <div id="perc-${id}" style="font-size:11px; text-align:right;">0%</div>
    </div>`;
    document.getElementById('transfers').insertAdjacentHTML('afterbegin', html);
}

function updateUI(id, curr, total) {
    const p = Math.floor((Math.min(curr, total) / total) * 100);
    if(document.getElementById(`bar-${id}`)) document.getElementById(`bar-${id}`).value = p;
    if(document.getElementById(`perc-${id}`)) document.getElementById(`perc-${id}`).innerText = p + "%";
}

function updateStatus(t, a) {
    const e = document.getElementById('status');
    e.innerText = t; a ? e.classList.add('active') : e.classList.remove('active');
}
