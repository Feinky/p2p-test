let peer, connections = {}, myFiles = {}, remoteFiles = {};
const CHUNK_SIZE = 16384; 

async function joinMesh() {
    const room = document.getElementById('roomInput').value.trim();
    if (!room) return;
    if (peer) peer.destroy();

    const myId = `TITAN-${room}-${Math.floor(Math.random() * 10000)}`;
    peer = new Peer(myId, { config: {'iceServers': [{ 'urls': 'stun:stun.l.google.com:19302' }] }});

    peer.on('open', (id) => {
        updateStatus("ONLINE", true);
        // Look for slots 1-5
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
        delete connections[c.peer]; 
        delete remoteFiles[c.peer]; 
        renderPeers();
        renderRemote(); 
        updateStatus(`MESH: ${Object.keys(connections).length}`, !!Object.keys(connections).length);
    });
}

function renderPeers() {
    const gallery = document.getElementById('peerGallery');
    if (!gallery) return;
    gallery.innerHTML = Object.keys(connections).map(pid => {
        const shortId = pid.split('-').pop();
        return `<div class="pill active" style="font-size:9px;">ID: ${shortId}</div>`;
    }).join('');
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

// SENDER: No longer uses .arrayBuffer()
async function upload(name, c) {
    const f = myFiles[name];
    if (!f) return;
    const tid = Math.random().toString(36).substr(2, 5);
    createRow(tid, f.name, 'SENDING');

    // For 1GB+, we don't hash the whole file upfront (too slow/RAM heavy)
    // We send a signature: Name + Size + Last Modified
    const signature = `${f.name}-${f.size}-${f.lastModified}`;
    c.send({ type: 'meta', name: f.name, size: f.size, tid: tid, hash: signature });

    const reader = f.stream().getReader(); // STREAMING START
    let off = 0;

    while (true) {
        const { done, value } = await reader.read();
        if (done || !c.open) break;

        // Backpressure check (Critical for speed)
        if (c.dataChannel.bufferedAmount > 1048576) {
            await new Promise(r => setTimeout(r, 30));
        }

        c.send(value);
        off += value.byteLength;
        updateUI(tid, off, f.size);
    }
    if (c.open) setTimeout(() => c.send({ type: 'eof', tid: tid }), 500);
}

// RECEIVER: Writes to Disk, not RAM
async function download(meta, c) {
    createRow(meta.tid, meta.name, 'DISK ACCESS...');
    
    let writable;
    try {
        // Asks user where to save BEFORE download starts
        const handle = await window.showSaveFilePicker({ suggestedName: meta.name });
        writable = await handle.createWritable();
    } catch (e) {
        return; // User cancelled
    }

    let received = 0;
    const handler = async (data) => {
        if (data.type === 'eof' && data.tid === meta.tid) {
            c.off('data', handler);
            await writable.close(); // Finalizes file
            document.getElementById(`tag-${meta.tid}`).innerText = "DONE";
            return;
        }

        if (data instanceof ArrayBuffer || data instanceof Uint8Array) {
            await writable.write(data); // WRITES DIRECTLY TO DISK
            received += data.byteLength;
            updateUI(meta.tid, received, meta.size);
        }
    };
    c.on('data', handler);
}

async function finalize(tid, name, chunks, expectedHash, c) {
    const tag = document.getElementById(`tag-${tid}`);
    const row = document.getElementById(`row-${tid}`);
    tag.innerText = "VERIFYING...";
    
    const blob = new Blob(chunks);
    const actualBuf = await blob.arrayBuffer();
    const hashBuffer = await crypto.subtle.digest('SHA-256', actualBuf);
    const actualHash = Array.from(new Uint8Array(hashBuffer)).map(b => b.toString(16).padStart(2, '0')).join('');

    if (actualHash !== expectedHash) {
        tag.innerText = "CORRUPT";
        tag.style.color = "#ff4444";
        
        // --- ADD RETRY BUTTON ---
        // We find the percentage div and replace it with a button
        const percDiv = document.getElementById(`perc-${tid}`); // Check this ID!
        if (percDiv) {
            percDiv.innerHTML = `<button class="btn" onclick="retryTransfer('${name}', '${c.peer}', '${tid}')">RETRY</button>`;
        }
    } else {
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url; a.download = name; a.click();
        tag.innerText = "DONE";
        tag.style.color = "#8bc34a";
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

function retryTransfer(name, peerId, oldTid) {
    // Remove the failed row so a new one can take its place
    const oldRow = document.getElementById(`row-${oldTid}`);
    if (oldRow) oldRow.remove();

    // Re-request the file
    if (connections[peerId]) {
        connections[peerId].send({ type: 'req', name: name });
    }
}
function updateStatus(t, a) {
    const e = document.getElementById('status');
    e.innerText = t; a ? e.classList.add('active') : e.classList.remove('active');
}



