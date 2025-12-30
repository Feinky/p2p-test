let peer, connections = {}, myFiles = {}, remoteFiles = {}, activeTransfers = {};
const CHUNK_SIZE = 65536; // 64KB for better throughput
const PART_SIZE = 250 * 1024 * 1024; // 250MB Slices

async function joinMesh() {
    const room = document.getElementById('roomInput').value.trim();
    if (!room) return;
    
    // Request Wake Lock to prevent phone from sleeping
    if ('wakeLock' in navigator) {
        try { await navigator.wakeLock.request('screen'); } catch (err) {}
    }

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
        if (data.type === 'cancel') {
            activeTransfers[data.tid] = false;
            document.getElementById(`tag-${data.tid}`).innerText = "CANCELLED";
        }
    });
    c.on('close', () => { 
        delete connections[c.peer]; delete remoteFiles[c.peer]; 
        renderPeers(); renderRemote(); 
        updateStatus(`MESH: ${Object.keys(connections).length}`, !!Object.keys(connections).length);
    });
}

// --- SENDER: Constant Memory Stream ---
async function upload(name, c) {
    const f = myFiles[name];
    if (!f) return;

    const tid = Math.random().toString(36).substr(2, 5);
    activeTransfers[tid] = true;
    createRow(tid, f.name, 'STREAMING OUT', c.peer);

    // Send Metadata
    c.send({ type: 'meta', name: f.name, size: f.size, tid: tid });

    // Use the native stream reader to read the file in tiny chunks
    const reader = f.stream().getReader();
    let sentBytes = 0;

    try {
        while (activeTransfers[tid]) {
            const { done, value } = await reader.read();
            if (done) break;

            // SMART BACKPRESSURE: If the network pipe is full, wait.
            if (c.dataChannel.bufferedAmount > 1048576) { // 1MB Buffer Limit
                await new Promise(resolve => {
                    const check = () => {
                        if (c.dataChannel.bufferedAmount < 256000) resolve();
                        else setTimeout(check, 30);
                    };
                    check();
                });
            }

            // Send the chunk (value is a Uint8Array)
            c.send(value);
            sentBytes += value.byteLength;
            updateUI(tid, sentBytes, f.size);
        }

        if (activeTransfers[tid]) {
            c.send({ type: 'eof', tid: tid });
            document.getElementById(`tag-${tid}`).innerText = "SENT";
        }
    } catch (err) {
        console.error("Stream failed", err);
    }
}
// --- RECEIVER: Direct-to-Disk Stream ---
async function download(meta, c) {
    activeTransfers[meta.tid] = true;
    createRow(meta.tid, meta.name, 'AUTHORIZING...', c.peer);

    let writable;
    try {
        // 1. Ask the user where to save the file BEFORE data arrives
        const handle = await window.showSaveFilePicker({ suggestedName: meta.name });
        writable = await handle.createWritable();
        document.getElementById(`tag-${meta.tid}`).innerText = "WRITING TO DISK";
    } catch (e) {
        console.log("User denied file access");
        return;
    }

    let receivedBytes = 0;

    const handler = async (data) => {
        if (!activeTransfers[meta.tid]) {
            c.off('data', handler);
            await writable.abort();
            return;
        }

        if (data.type === 'eof' && data.tid === meta.tid) {
            c.off('data', handler);
            await writable.close(); // Saves the file
            document.getElementById(`tag-${meta.tid}`).innerText = "SAVED";
            document.getElementById(`tag-${meta.tid}`).style.color = "#8bc34a";
            return;
        }

        // Handle binary data chunks
        if (data instanceof ArrayBuffer || data instanceof Uint8Array) {
            await writable.write(data); // Write chunk directly to disk
            receivedBytes += data.byteLength;
            updateUI(meta.tid, receivedBytes, meta.size);
        }
    };

    c.on('data', handler);
}
// --- UI HELPERS ---
function createRow(id, name, type, peerId) {
    const html = `
    <div class="transfer-row" id="row-${id}" style="border-bottom:1px solid #333; padding:10px 0;">
        <div style="display:flex; justify-content:space-between; align-items:center;">
            <div>
                <div id="tag-${id}" style="font-size:9px; font-weight:bold; color:var(--p)">${type}</div>
                <div style="font-size:11px; max-width:150px; overflow:hidden;">${name}</div>
            </div>
            <button class="btn" style="background:#ff4444; padding:2px 8px; font-size:9px;" onclick="cancelXfer('${id}', '${peerId}')">CANCEL</button>
        </div>
        <progress id="bar-${id}" value="0" max="100" style="width:100%; height:4px;"></progress>
        <div id="perc-${id}" style="font-size:10px; text-align:right;">0%</div>
    </div>`;
    document.getElementById('transfers').insertAdjacentHTML('afterbegin', html);
}

function cancelXfer(tid, pid) {
    activeTransfers[tid] = false;
    if (connections[pid]) connections[pid].send({ type: 'cancel', tid: tid });
    document.getElementById(`tag-${tid}`).innerText = "STOPPED";
}

function updateUI(id, curr, total) {
    const p = Math.floor((curr / total) * 100);
    const bar = document.getElementById(`bar-${id}`);
    const perc = document.getElementById(`perc-${id}`);
    if(bar) bar.value = p;
    if(perc) perc.innerText = p + "%";
}

// --- BOILERPLATE RENDERERS ---
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

function sync(c) { if (c?.open) c.send({ type: 'list', files: Object.values(myFiles).map(f => ({ name: f.name, size: f.size })) }); }

function renderRemote() {
    const ui = document.getElementById('peerList'); ui.innerHTML = "";
    Object.entries(remoteFiles).forEach(([pid, files]) => {
        files.forEach(f => {
            ui.innerHTML += `<div class="file-row">
                <span>${f.name} <small style="color:var(--p)">(${pid.split('-').pop()})</small></span>
                <button class="btn" onclick="connections['${pid}'].send({type:'req', name:'${f.name}'})">GET</button>
            </div>`;
        });
    });
}

function updateStatus(t, a) {
    const e = document.getElementById('status');
    e.innerText = t; a ? e.classList.add('active') : e.classList.remove('active');
}

