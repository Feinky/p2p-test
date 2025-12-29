let peer, connections = {}, myFiles = {}, remoteFiles = {};
const CHUNK_SIZE = 16384; 

async function joinMesh() {
    const room = document.getElementById('roomInput').value.trim();
    if (!room) return;
    if (peer) peer.destroy();

    const myId = `TITAN-${room}-${Math.floor(Math.random() * 10000)}`;
    peer = new Peer(myId, { config: {'iceServers': [{ 'urls': 'stun:stun.l.google.com:19302' }] }});

    peer.on('open', () => {
        updateStatus("ONLINE", true);
        for(let i=1; i<=5; i++) {
            const t = `TITAN-LOBBY-${room}-${i}`;
            if (peer.id !== t) handleConn(peer.connect(t));
        }
        tryLobby(room, 1);
    });

    peer.on('connection', c => handleConn(c));
}

function tryLobby(room, s) {
    if (s > 5) return;
    const lId = `TITAN-LOBBY-${room}-${s}`;
    const lPeer = new Peer(lId, { config: {'iceServers': [{ 'urls': 'stun:stun.l.google.com:19302' }] }});
    lPeer.on('open', () => lPeer.on('connection', c => handleConn(c)));
    lPeer.on('error', () => { lPeer.destroy(); tryLobby(room, s+1); });
}

function handleConn(c) {
    if (!c || connections[c.peer]) return;
    c.on('open', () => {
        connections[c.peer] = c;
        updateStatus(`MESH: ${Object.keys(connections).length}`, true);
        sync(c);
    });
    c.on('data', data => {
        if (data.type === 'list') { remoteFiles[c.peer] = data.files; renderRemote(); }
        
        // CONSISTENT SENDER LOGIC: Responds to both initial 'req' and 'retry' yells
        if (data.type === 'req' || data.type === 'retry') {
            upload(data.name, c); 
        }
        
        if (data.type === 'meta') download(data, c);
    });
    c.on('close', () => { 
        delete connections[c.peer]; 
        delete remoteFiles[c.peer]; 
        renderRemote(); 
        updateStatus(`MESH: ${Object.keys(connections).length}`, !!Object.keys(connections).length);
    });
}

function updateStatus(t, a) {
    const e = document.getElementById('status');
    e.innerText = t;
    a ? e.classList.add('active') : e.classList.remove('active');
}

document.getElementById('fileInput').onchange = (e) => {
    for (let f of e.target.files) {
        myFiles[f.name] = f;
        document.getElementById('myList').innerHTML += `<div class="file-row">${f.name}</div>`;
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
                <span>${f.name}</span>
                <button class="btn" style="padding:2px 8px; font-size:11px" onclick="connections['${pid}'].send({type:'req', name:'${f.name}'})">GET</button>
            </div>`;
        });
    });
}

// --- BINARY SENDER ---
async function upload(name, c) {
    const f = myFiles[name];
    if (!f) return;
    const tid = Math.random().toString(36).substr(2, 5);
    createRow(tid, name, 'PREPARING');

    const buf = await f.arrayBuffer();
    const hashBuffer = await crypto.subtle.digest('SHA-256', buf);
    const fileHash = Array.from(new Uint8Array(hashBuffer)).map(b => b.toString(16).padStart(2, '0')).join('');

    c.send({ type: 'meta', name: f.name, size: f.size, tid: tid, hash: fileHash });
    
    let off = 0;
    document.getElementById(`tag-${tid}`).innerText = "SENDING";

    while (off < f.size) {
        if (!c.open) break;
        if (c.dataChannel.bufferedAmount > 1048576) {
            await new Promise(r => setTimeout(r, 50)); 
            continue;
        }
        c.send(buf.slice(off, off + CHUNK_SIZE));
        off += CHUNK_SIZE;
        updateUI(tid, off, f.size);
    }
    
    if (c.open) setTimeout(() => { c.send({ type: 'eof', tid: tid }); }, 500);
}

// --- BINARY RECEIVER ---
function download(meta, c) {
    // Clear any previous attempts for this specific file tid
    const existing = document.getElementById(`row-${meta.tid}`);
    if(existing) existing.remove();

    createRow(meta.tid, meta.name, 'RECEIVING');
    let receivedBytes = 0;
    let chunks = [];
    
    const handler = async (data) => {
        if (data.type === 'eof' && data.tid === meta.tid) {
            c.off('data', handler);
            await verifyAndFinalize(meta, chunks, c);
            return;
        }
        if (data instanceof ArrayBuffer || data instanceof Uint8Array || data.byteLength !== undefined) {
            chunks.push(data);
            receivedBytes += data.byteLength;
            updateUI(meta.tid, receivedBytes, meta.size);
        }
    };
    c.on('data', handler);
}

async function verifyAndFinalize(meta, chunks, c) {
    const tag = document.getElementById(`tag-${meta.tid}`);
    tag.innerText = "VERIFYING...";
    
    const blob = new Blob(chunks, { type: 'application/octet-stream' });
    const actualBuf = await blob.arrayBuffer();
    const hashBuffer = await crypto.subtle.digest('SHA-256', actualBuf);
    const actualHash = Array.from(new Uint8Array(hashBuffer)).map(b => b.toString(16).padStart(2, '0')).join('');

    if (actualHash !== meta.hash) {
        tag.innerText = "FAILED: YELLING RETRY";
        tag.style.color = "#ffbb00";
        // REQUESTER YELLS TO SENDER
        setTimeout(() => {
            c.send({ type: 'retry', name: meta.name });
        }, 1500);
    } else {
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url; a.download = meta.name; a.click();
        tag.innerText = "VERIFIED";
        tag.style.color = "var(--success)";
        setTimeout(() => URL.revokeObjectURL(url), 10000);
    }
}

// --- UI HELPERS ---
function createRow(id, name, type) {
    const html = `<div class="transfer-row" id="row-${id}">
        <div><div id="tag-${id}" style="font-size:9px; font-weight:bold; color:var(--p)">${type}</div><div style="font-size:11px; white-space:nowrap; overflow:hidden;">${name}</div></div>
        <progress id="bar-${id}" value="0" max="100"></progress>
        <div id="perc-${id}" style="font-size:11px; text-align:right;">0%</div>
    </div>`;
    document.getElementById('transfers').insertAdjacentHTML('afterbegin', html);
}

function updateUI(id, curr, total) {
    const p = Math.floor((Math.min(curr, total) / total) * 100);
    const bar = document.getElementById(`bar-${id}`);
    const perc = document.getElementById(`perc-${id}`);
    if(bar) bar.value = p;
    if(perc) perc.innerText = p + "%";
}
