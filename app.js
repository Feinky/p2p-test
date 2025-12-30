let peer, connections = {}, myFiles = {}, activeTransfers = {};
const CHUNK_SIZE = 65536; 
const BLOCK_SIZE = 10 * 1024 * 1024; // 10MB Blocks for verification

async function joinMesh() {
    const room = document.getElementById('roomInput').value.trim();
    if (!room) return;
    if (peer) peer.destroy();
    
    const myId = `TITAN-${room}-${Math.floor(Math.random() * 10000)}`;
    peer = new Peer(myId, { config: {'iceServers': [{ 'urls': 'stun:stun.l.google.com:19302' }] }});

    peer.on('open', () => {
        updateStatus("ONLINE", true);
        // Try to find peers in lobby slots
        for(let i=1; i<=5; i++) {
            const t = `TITAN-LOBBY-${room}-${i}`;
            if (peer.id !== t) handleConn(peer.connect(t));
        }
        tryLobby(room, 1);
    });
    peer.on('connection', c => handleConn(c));
}

// ... (tryLobby and renderPeers remain the same as your current code) ...

function handleConn(c) {
    if (!c || connections[c.peer]) return;
    c.on('open', () => {
        connections[c.peer] = c;
        updateStatus(`MESH: ${Object.keys(connections).length}`, true);
        sync(c);
    });
    c.on('data', data => {
        if (data.type === 'list') { remoteFiles[c.peer] = data.files; renderRemote(); }
        if (data.type === 'req') upload(data.name, c); // Peer wants my file
        if (data.type === 'meta') download(data, c);  // Peer is sending me meta
    });
}

// --- SENDER ---
async function upload(name, c) {
    const f = myFiles[name];
    if (!f) return;
    const tid = Math.random().toString(36).substr(2, 5);
    activeTransfers[tid] = true;
    createRow(tid, f.name, 'READY');

    // 1. Tell receiver the file exists and wait for them to ask for Block 0
    c.send({ type: 'meta', name: f.name, size: f.size, tid: tid });

    const sendHandler = async (data) => {
        if (data.tid !== tid) return;
        
        if (data.type === 'pull_block') {
            const i = data.index;
            const start = i * BLOCK_SIZE;
            const end = Math.min(start + BLOCK_SIZE, f.size);
            const blob = f.slice(start, end);
            const buf = await blob.arrayBuffer();
            
            // Hash the block
            const hashBuf = await crypto.subtle.digest('SHA-256', buf);
            const hash = Array.from(new Uint8Array(hashBuf)).map(b => b.toString(16).padStart(2, '0')).join('');

            // Send metadata for this block
            c.send({ type: 'block_meta', tid: tid, index: i, hash: hash });

            // Send raw data
            let off = 0;
            while (off < buf.byteLength) {
                if (c.dataChannel.bufferedAmount > 1048576) {
                    await new Promise(r => setTimeout(r, 30));
                    continue;
                }
                c.send(buf.slice(off, off + CHUNK_SIZE));
                off += CHUNK_SIZE;
            }
            c.send({ type: 'block_end', tid: tid, index: i });
            updateUI(tid, start + buf.byteLength, f.size);
        }
    };
    c.on('data', sendHandler);
}

// --- RECEIVER ---
async function download(meta, c) {
    activeTransfers[meta.tid] = true;
    createRow(meta.tid, meta.name, 'PREPARING...');

    const handle = await window.showSaveFilePicker({ suggestedName: meta.name });
    const writable = await handle.createWritable();
    
    let currentBlockChunks = [];
    let expectedHash = "";
    let currentIdx = 0;
    const totalBlocks = Math.ceil(meta.size / BLOCK_SIZE);

    const receiveHandler = async (data) => {
        if (data.tid !== meta.tid && !(data instanceof ArrayBuffer)) return;

        if (data.type === 'block_meta') {
            expectedHash = data.hash;
            currentBlockChunks = [];
            document.getElementById(`tag-${meta.tid}`).innerText = `BLOCK ${data.index + 1}/${totalBlocks}`;
        } else if (data instanceof ArrayBuffer || data instanceof Uint8Array) {
            currentBlockChunks.push(data);
        } else if (data.type === 'block_end') {
            // VERIFY
            const blockBlob = new Blob(currentBlockChunks);
            const blockBuf = await blockBlob.arrayBuffer();
            const actualHashBuf = await crypto.subtle.digest('SHA-256', blockBuf);
            const actualHash = Array.from(new Uint8Array(actualHashBuf)).map(b => b.toString(16).padStart(2, '0')).join('');

            if (actualHash === expectedHash) {
                await writable.write(blockBuf);
                currentIdx++;
                if (currentIdx < totalBlocks) {
                    c.send({ type: 'pull_block', tid: meta.tid, index: currentIdx });
                } else {
                    await writable.close();
                    document.getElementById(`tag-${meta.tid}`).innerText = "DONE & VERIFIED";
                    c.off('data', receiveHandler);
                }
            } else {
                // AUTO-FIX: Request the same block again
                document.getElementById(`tag-${meta.tid}`).innerText = "RETRYING BLOCK...";
                c.send({ type: 'pull_block', tid: meta.tid, index: currentIdx });
            }
            updateUI(meta.tid, currentIdx * BLOCK_SIZE, meta.size);
        }
    };

    c.on('data', receiveHandler);
    // KICKSTART THE PROCESS: Ask for the first block
    c.send({ type: 'pull_block', tid: meta.tid, index: 0 });
}
