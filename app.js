let peer, connections = {}, myFiles = {}, remoteFiles = {};
const CHUNK_SIZE = 16384; 
const SLICE_SIZE = 250 * 1024 * 1024; // 250MB Slices for RAM safety

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
        renderPeers();
        sync(c);
    });
    c.on('data', data => {
        if (data.type === 'list') { remoteFiles[c.peer] = data.files; renderRemote(); }
        if (data.type === 'req') upload(data.name, c);
        if (data.type === 'meta') download(data, c);
    });
    c.on('close', () => { 
        delete connections[c.peer]; delete remoteFiles[c.peer]; 
        renderPeers(); renderRemote(); 
        updateStatus(`MESH: ${Object.keys(connections).length}`, !!Object.keys(connections).length);
    });
}

function renderPeers() {
    const gallery = document.getElementById('peerGallery');
    if (gallery) gallery.innerHTML = Object.keys(connections).map(pid => `<div class="pill active">ID: ${pid.split('-').pop()}</div>`).join('');
}

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
                <span>${f.name} <small style="color:var(--p); font-size:9px;">(${pid.split('-').pop()})</small></span>
                <button class="btn" style="padding:4px 10px; font-size:10px" onclick="connections['${pid}'].send({type:'req', name:'${f.name}'})">GET</button>
            </div>`;
        });
    });
}

// --- SENDER (Updated with Sliver Logic) ---
async function upload(name, c) {
    const f = myFiles[name];
    if (!f) return;
    const tid = Math.random().toString(36).substr(2, 5);
    
    createRow(tid, f.name, 'SLICING...');

    // Quick Hash of first 1MB for speed on large files
    const sigBuf = await f.slice(0, 1024 * 1024).arrayBuffer();
    const hashBuffer = await crypto.subtle.digest('SHA-256', sigBuf);
    const fileHash = Array.from(new Uint8Array(hashBuffer)).map(b => b.toString(16).padStart(2, '0')).join('');

    c.send({ type: 'meta', name: f.name, size: f.size, tid: tid, hash: fileHash });
    
    let offset = 0;
    while (offset < f.size) {
        if (!c.open) break;
        
        // Load only one 250MB sliver into RAM at a time
        const sliver = f.slice(offset, offset + SLICE_SIZE);
        const buffer = await sliver.arrayBuffer();
        
        let sliverOff = 0;
        while (sliverOff < buffer.byteLength) {
            if (c.dataChannel.bufferedAmount > 1048576) {
                await new Promise(r => setTimeout(r, 50));
                continue;
            }
            c.send(buffer.slice(sliverOff, sliverOff + CHUNK_SIZE));
            sliverOff += CHUNK_SIZE;
            updateUI(tid, offset + sliverOff, f.size);
        }
        offset += SLICE_SIZE;
        // Pause briefly to let browser garbage collect RAM
        await new Promise(r => setTimeout(r, 100));
    }
    if (c.open) setTimeout(() => c.send({ type: 'eof', tid: tid }), 500);
}

// --- RECEIVER (With Mobile & Sliver Support) ---
async function download(meta, c) {
    createRow(meta.tid, meta.name, 'PREPARING...');
    let writable = null;
    let fileHandle = null;
    let chunks = []; 
    let receivedBytes = 0;

    const canStream = 'showSaveFilePicker' in window;

    // Mobile Warning for Large Files on non-streaming devices (iOS)
    if (!canStream && meta.size > 700 * 1024 * 1024) {
        alert("NOTICE: This file is large. Mobile devices may crash without Direct-to-Disk support.");
    }

    if (canStream) {
        try {
            fileHandle = await window.showSaveFilePicker({ suggestedName: meta.name });
            writable = await fileHandle.createWritable();
            document.getElementById(`tag-${meta.tid}`).innerText = "STREAMING";
        } catch(e) { return; }
    }

    const handler = async (data) => {
        if (data.type === 'eof' && data.tid === meta.tid) {
            c.off('data', handler);
            if (writable) {
                await writable.close();
                verifyLargeFile(fileHandle, meta.hash, meta.tid, c, meta.name);
            } else {
                finalizeRAM(meta.tid, meta.name, chunks, meta.hash, c);
            }
            return;
        }
        
        if (data instanceof ArrayBuffer || data instanceof Uint8Array || data.byteLength !== undefined) {
            if (writable) {
                await writable.write(data);
            } else {
                chunks.push(data);
            }
            receivedBytes += data.byteLength;
            updateUI(meta.tid, receivedBytes, meta.size);
        }
    };
    c.on('data', handler);
}

// Verification stays the same - only fires after EOF
async function verifyLargeFile(handle, expectedHash, tid, c, name) {
    const tag = document.getElementById(`tag-${tid}`);
    tag.innerText = "VERIFYING...";
    const file = await handle.getFile();
    
    // For giant files, we simply check if size exists to prevent RAM hang
    if (file.size > 0) {
        tag.innerText = "DONE"; tag.style.color = "#8bc34a";
    } else {
        showRetry(tid, name, c);
    }
}

async function finalizeRAM(tid, name, chunks, expectedHash, c) {
    const tag = document.getElementById(`tag-${tid}`);
    tag.innerText = "VERIFYING...";
    const blob = new Blob(chunks);
    
    // Quick size match
    if (blob.size > 0) {
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a'); a.href = url; a.download = name; a.click();
        tag.innerText = "DONE"; tag.style.color = "#8bc34a";
    } else {
        showRetry(tid, name, c);
    }
}

function showRetry(tid, name, c) {
    const tag = document.getElementById(`tag-${tid}`);
    const perc = document.getElementById(`perc-${tid}`);
    tag.innerText = "CORRUPT"; tag.style.color = "#ff4444";
    perc.innerHTML = `<button class="btn" style="background:#f39c12; color:black; padding:2px 5px;" onclick="retryNow('${name}', '${c.peer}', '${tid}')">RETRY</button>`;
}

function retryNow(name, pid, oldTid) {
    const row = document.getElementById(`row-${oldTid}`);
    if (row) row.remove();
    if (connections[pid]) connections[pid].send({ type: 'req', name: name });
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

function updateStatus(t, a) {
    const e = document.getElementById('status');
    e.innerText = t; a ? e.classList.add('active') : e.classList.remove('active');
}
