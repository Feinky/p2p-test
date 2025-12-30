let peer, connections = {}, myFiles = {}, remoteFiles = {}, activeTransfers = {};
const CHUNK_SIZE = 65536; 
const BLOCK_SIZE = 10 * 1024 * 1024; // 10MB blocks for hashing/verification

// --- MESH NETWORKING ---
async function joinMesh() {
    const room = document.getElementById('roomInput').value.trim();
    if (!room) return;
    
    // Keep mobile screens awake during large transfers
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
            const tag = document.getElementById(`tag-${data.tid}`);
            if(tag) tag.innerText = "CANCELLED";
        }
    });
    c.on('close', () => { 
        delete connections[c.peer]; delete remoteFiles[c.peer]; 
        renderPeers(); renderRemote(); 
        updateStatus(`MESH: ${Object.keys(connections).length}`, !!Object.keys(connections).length);
    });
}

// --- SENDER (PULL-BASED) ---
async function upload(name, c) {
    const f = myFiles[name];
    if (!f) return;
    const tid = Math.random().toString(36).substr(2, 5);
    activeTransfers[tid] = true;
    createRow(tid, f.name, 'WAITING', c.peer);

    // Initial Handshake
    c.send({ type: 'meta', name: f.name, size: f.size, tid: tid });

    const sendHandler = async (data) => {
        if (!activeTransfers[tid] || data.tid !== tid) return;
        
        if (data.type === 'pull_block') {
            const start = data.index * BLOCK_SIZE;
            const end = Math.min(start + BLOCK_SIZE, f.size);
            const slice = f.slice(start, end);
            const buf = await slice.arrayBuffer();
            
            // Integrity Hash
            const hashBuf = await crypto.subtle.digest('SHA-256', buf);
            const hash = Array.from(new Uint8Array(hashBuf)).map(b => b.toString(16).padStart(2, '0')).join('');

            c.send({ type: 'block_meta', tid: tid, index: data.index, hash: hash });

            let off = 0;
            while (off < buf.byteLength) {
                if (c.dataChannel.bufferedAmount > 1048576) {
                    await new Promise(r => setTimeout(r, 30));
                    continue;
                }
                c.send(buf.slice(off, off + CHUNK_SIZE));
                off += CHUNK_SIZE;
            }
            c.send({ type: 'block_end', tid: tid, index: data.index });
        }
    };
    c.on('data', sendHandler);
}

// --- RECEIVER (DIRECT-TO-DISK + AUTO-HEAL) ---
async function download(meta, c) {
    activeTransfers[meta.tid] = true;
    createRow(meta.tid, meta.name, 'DISK READY?', c.peer);

    let writable;
    try {
        const handle = await window.showSaveFilePicker({ suggestedName: meta.name });
        writable = await handle.createWritable();
    } catch (e) {
        updateStatus("SAVE CANCELLED", false);
        return;
    }

    let chunks = [], receivedTotal = 0, startTime = Date.now(), currentIdx = 0;
    const totalBlocks = Math.ceil(meta.size / BLOCK_SIZE);
    let expectedHash = "";

    const receiveHandler = async (data) => {
        if (!activeTransfers[meta.tid]) { c.off('data', receiveHandler); return; }

        if (data instanceof ArrayBuffer || data instanceof Uint8Array) {
            chunks.push(data);
            return;
        }

        if (data.tid !== meta.tid) return;

        if (data.type === 'block_meta') {
            chunks = [];
            expectedHash = data.hash;
            document.getElementById(`tag-${meta.tid}`).innerText = `BLOCK ${data.index + 1}/${totalBlocks}`;
        } else if (data.type === 'block_end') {
            const blockBlob = new Blob(chunks);
            const blockBuf = await blockBlob.arrayBuffer();
            const actualHash = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', blockBuf)))
                                .map(b => b.toString(16).padStart(2, '0')).join('');

            if (actualHash === expectedHash) {
                await writable.write(blockBuf);
                receivedTotal += blockBuf.byteLength;
                currentIdx++;
                
                const elapsed = (Date.now() - startTime) / 1000;
                const mbps = (receivedTotal / (1024 * 1024) / elapsed).toFixed(1);
                updateUI(meta.tid, receivedTotal, meta.size, `${mbps} MB/s`);

                if (currentIdx < totalBlocks) {
                    c.send({ type: 'pull_block', tid: meta.tid, index: currentIdx });
                } else {
                    await writable.close();
                    document.getElementById(`tag-${meta.tid}`).innerText = "DONE";
                    document.getElementById(`tag-${meta.tid}`).style.color = "#8bc34a";
                    c.off('data', receiveHandler);
                }
            } else {
                // AUTO-HEAL: Re-request the specific failed block
                document.getElementById(`tag-${meta.tid}`).innerText = "RETRYING...";
                c.send({ type: 'pull_block', tid: meta.tid, index: currentIdx });
            }
        }
    };

    c.on('data', receiveHandler);
    c.send({ type: 'pull_block', tid: meta.tid, index: 0 });
}

// --- UI COMPONENTS ---
function updateUI(id, curr, total, speed = "") {
    const p = Math.floor((curr / total) * 100);
    const bar = document.getElementById(`bar-${id}`);
    const perc = document.getElementById(`perc-${id}`);
    if(bar) bar.value = p;
    if(perc) perc.innerText = speed ? `${p}% (${speed})` : `${p}%`;
}

function createRow(id, name, type, peerId) {
    const html = `
    <div class="transfer-row" id="row-${id}" style="border-bottom:1px solid #333; padding:10px 0;">
        <div style="display:flex; justify-content:space-between; align-items:center;">
            <div>
                <div id="tag-${id}" style="font-size:9px; font-weight:bold; color:var(--p)">${type}</div>
                <div style="font-size:11px; max-width:180px; overflow:hidden;">${name}</div>
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
}

function sync(c) { if (c?.open) c.send({ type: 'list', files: Object.values(myFiles).map(f => ({ name: f.name, size: f.size })) }); }

function updateStatus(t, a) {
    const e = document.getElementById('status');
    e.innerText = t; a ? e.classList.add('active') : e.classList.remove('active');
}

function renderPeers() {
    const gallery = document.getElementById('peerGallery');
    if (gallery) gallery.innerHTML = Object.keys(connections).map(pid => `<div class="pill active">ID: ${pid.split('-').pop()}</div>`).join('');
}

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

document.getElementById('fileInput').onchange = (e) => {
    for (let f of e.target.files) {
        myFiles[f.name] = f;
        document.getElementById('myList').innerHTML += `<div class="file-row"><span>${f.name}</span></div>`;
    }
    Object.values(connections).forEach(c => sync(c));
};
