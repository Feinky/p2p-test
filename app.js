let peer, connections = {}, myFiles = {}, remoteFiles = {};
const CHUNK_SIZE = 16384; 

async function joinMesh() {
    const room = document.getElementById('roomInput').value.trim();
    if (!room) return;
    
    // Cleanup previous peer if it exists
    if (peer) peer.destroy();

    const myId = `TITAN-${room}-${Math.floor(Math.random() * 10000)}`;
    peer = new Peer(myId, { config: {'iceServers': [{ 'urls': 'stun:stun.l.google.com:19302' }] }});
    
    peer.on('open', () => { 
        updateStatus("ONLINE", true); 
        discover(room); 
    });
    
    peer.on('connection', c => handleConn(c));
}

function discover(room) {
    for(let i=1; i<=5; i++) {
        const t = `TITAN-LOBBY-${room}-${i}`;
        if (peer.id !== t) handleConn(peer.connect(t));
    }
}

function handleConn(c) {
    if (!c || connections[c.peer]) return;
    
    c.on('open', () => {
        connections[c.peer] = c;
        updateStatus(`MESH: ${Object.keys(connections).length}`, true);
        sync(c);
    });

    c.on('data', data => {
        // SENDER LOGIC: Responds to initial requests OR auto-retries
        if (data.type === 'req' || data.type === 'retry') {
            upload(data.name, c); 
        }
        if (data.type === 'list') { 
            remoteFiles[c.peer] = data.files; 
            renderRemote(); 
        }
        if (data.type === 'meta') {
            download(data, c);
        }
    });

    c.on('close', () => {
        delete connections[c.peer];
        delete remoteFiles[c.peer];
        renderRemote();
        updateStatus(`MESH: ${Object.keys(connections).length}`, Object.keys(connections).length > 0);
    });
}

// --- FILE SELECTION ---
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
    const ui = document.getElementById('peerList'); 
    ui.innerHTML = "";
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
    
    createRow(tid, name, 'HASHING');

    const buf = await f.arrayBuffer();
    const hashBuffer = await crypto.subtle.digest('SHA-256', buf);
    const fileHash = Array.from(new Uint8Array(hashBuffer)).map(b => b.toString(16).padStart(2, '0')).join('');

    c.send({ type: 'meta', name: f.name, size: f.size, tid: tid, hash: fileHash });
    
    let off = 0;
    document.getElementById(`tag-${tid}`).innerText = "SENDING";

    while (off < f.size) {
        if (!c.open) break;
        if (c.dataChannel.bufferedAmount > 1000000) { 
            await new Promise(r => setTimeout(r, 50)); 
            continue; 
        }
        c.send(buf.slice(off, off + CHUNK_SIZE));
        off += CHUNK_SIZE;
        updateUI(tid, off, f.size);
    }
    if (c.open) setTimeout(() => c.send({ type: 'eof', tid: tid }), 500);
}

// --- BINARY RECEIVER WITH AUTO-RETRY ---
function download(meta, c) {
    // Remove old bar if this is a retry
    const oldRow = document.querySelector(`[data-filename="${meta.name}"]`);
    if (oldRow) oldRow.remove();

    createRow(meta.tid, meta.name, 'RECEIVING', meta.name);
    let chunks = [];
    let receivedBytes = 0;
    
    const handler = async (data) => {
        if (data.type === 'eof' && data.tid === meta.tid) {
            c.off('data', handler);
            
            // VERIFY HASH
            const blob = new Blob(chunks);
            const resBuf = await blob.arrayBuffer();
            const resHashBuf = await crypto.subtle.digest('SHA-256', resBuf);
            const resHash = Array.from(new Uint8Array(resHashBuf)).map(b => b.toString(16).padStart(2, '0')).join('');

            const tag = document.getElementById(`tag-${meta.tid}`);
            
            if (resHash === meta.hash) {
                const url = URL.createObjectURL(blob);
                const a = document.createElement('a');
                a.href = url; a.download = meta.name; a.click();
                tag.innerText = "VERIFIED";
                tag.style.color = "var(--success)";
            } else {
                // THE AUTO-RETRY LOGIC
                tag.innerText = "CORRUPT: RETRYING...";
                tag.style.color = "#ff4444";
                
                // Automatically re-trigger the GET request
                setTimeout(() => {
                    c.send({ type: 'retry', name: meta.name });
                }, 1000);
            }
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

// --- UI HELPERS ---
function createRow(id, name, label, filename = "") {
    const html = `<div class="transfer-row" id="row-${id}" data-filename="${filename || name}">
        <div><div id="tag-${id}" style="font-size:9px; font-weight:bold; color:var(--p)">${label}</div><div style="font-size:11px;">${name}</div></div>
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

function updateStatus(t, a) {
    const e = document.getElementById('status');
    e.innerText = t;
    a ? e.classList.add('active') : e.classList.remove('active');
}
