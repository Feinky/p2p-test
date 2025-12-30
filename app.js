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
// --- SENDER (With Re-send Capability) ---
async function upload(name, c) {
    const f = myFiles[name];
    if (!f) return;
    const tid = Math.random().toString(36).substr(2, 5);
    createRow(tid, f.name, 'SYNCING...');

    const BLOCK_SIZE = 10 * 1024 * 1024; // 10MB Blocks
    
    // Handler for "Retry" requests from receiver
    const requestHandler = async (data) => {
        if (data.type === 'retry_block' && data.tid === tid) {
            console.warn(`Block ${data.index} corrupted. Re-sending...`);
            sendBlock(data.index);
        }
    };
    c.on('data', requestHandler);

    async function sendBlock(index) {
        const start = index * BLOCK_SIZE;
        const end = Math.min(start + BLOCK_SIZE, f.size);
        const blob = f.slice(start, end);
        const buf = await blob.arrayBuffer();
        
        // Calculate hash for just this 10MB block
        const hashBuf = await crypto.subtle.digest('SHA-256', buf);
        const hash = Array.from(new Uint8Array(hashBuf)).map(b => b.toString(16).padStart(2, '0')).join('');

        c.send({ type: 'block_meta', tid: tid, index: index, hash: hash, size: blob.size });

        // Send actual data in CHUNKS (64KB)
        let off = 0;
        while (off < buf.byteLength) {
            if (c.dataChannel.bufferedAmount > 1048576) {
                await new Promise(r => setTimeout(r, 30));
                continue;
            }
            c.send(buf.slice(off, off + CHUNK_SIZE));
            off += CHUNK_SIZE;
        }
        c.send({ type: 'block_end', tid: tid, index: index });
    }

    // Start sending blocks sequentially
    for (let i = 0; i < Math.ceil(f.size / BLOCK_SIZE); i++) {
        if (!activeTransfers[tid]) break;
        await sendBlock(i);
        // Wait for receiver to "Approve" the block before starting next one
        await new Promise(resolve => {
            const waiter = (data) => {
                if (data.type === 'block_ok' && data.index === i) {
                    c.off('data', waiter);
                    resolve();
                }
            };
            c.on('data', waiter);
        });
        updateUI(tid, (i + 1) * BLOCK_SIZE, f.size);
    }
    c.send({ type: 'eof', tid: tid });
}
// --- RECEIVER (With Hash Verification) ---
async function download(meta, c) {
    activeTransfers[meta.tid] = true;
    const handle = await window.showSaveFilePicker({ suggestedName: meta.name });
    const writable = await handle.createWritable();
    
    let currentBlockChunks = [];
    let expectedHash = "";

    const handler = async (data) => {
        if (data.type === 'block_meta') {
            expectedHash = data.hash;
            currentBlockChunks = [];
        } else if (data.type === 'block_end') {
            // VERIFY BLOCK
            const blockBlob = new Blob(currentBlockChunks);
            const blockBuf = await blockBlob.arrayBuffer();
            const actualHashBuf = await crypto.subtle.digest('SHA-256', blockBuf);
            const actualHash = Array.from(new Uint8Array(actualHashBuf)).map(b => b.toString(16).padStart(2, '0')).join('');

            if (actualHash === expectedHash) {
                await writable.write(blockBuf); // Good data! Save to disk.
                c.send({ type: 'block_ok', tid: meta.tid, index: data.index });
            } else {
                // CORRUPT! Tell sender to try again
                console.error("Block Corrupt. Requesting retry...");
                c.send({ type: 'retry_block', tid: meta.tid, index: data.index });
            }
        } else if (data instanceof ArrayBuffer) {
            currentBlockChunks.push(data);
        } else if (data.type === 'eof') {
            await writable.close();
            c.off('data', handler);
            updateStatus("FILE VERIFIED & SAVED", true);
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


