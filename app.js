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
        // Discovery Logic
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
        if (data.type === 'req') upload(data.name, c);
        if (data.type === 'meta') download(data, c);
    });
    c.on('close', () => { delete connections[c.peer]; delete remoteFiles[c.peer]; renderRemote(); });
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

// --- SEQUENTIAL LOGIC ---

async function upload(name, c) {
    const f = myFiles[name];
    const tid = Math.random().toString(36).substr(2, 5);
    createRow(tid, name, 'SENDING');
    c.send({ type: 'meta', name: f.name, size: f.size, tid: tid });
    
    const buf = await f.arrayBuffer();
    let off = 0;
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
    
    // Send EOF only when loop is finished
    if (c.open) setTimeout(() => { c.send({ type: 'eof', tid: tid }); }, 500);
}

function download(meta, c) {
    createRow(meta.tid, meta.name, 'RECEIVING');
    let received = 0, chunks = [];
    
    const handler = (data) => {
        if (data.type === 'eof' && data.tid === meta.tid) {
            finalize(meta.tid, meta.name, chunks);
            c.off('data', handler);
            return;
        }
        if (data.type) return;
        chunks.push(data);
        received += data.byteLength;
        updateUI(meta.tid, received, meta.size);
    };
    c.on('data', handler);
}

function finalize(tid, name, chunks) {
    const tag = document.getElementById(`tag-${tid}`);
    tag.innerText = "SAVING...";
    const blob = new Blob(chunks, { type: 'application/octet-stream' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    a.click();
    tag.innerText = "DONE";
}

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
    if(document.getElementById(`bar-${id}`)) document.getElementById(`bar-${id}`).value = p;
    if(document.getElementById(`perc-${id}`)) document.getElementById(`perc-${id}`).innerText = p + "%";
}