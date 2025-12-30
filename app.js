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

async function upload(name, c) {

    const f = myFiles[name];

    if (!f) return;



    const PART_SIZE = 250 * 1024 * 1024; // 250MB per slice

    const totalParts = Math.ceil(f.size / PART_SIZE);

    

    // Loop through each slice and send it as a separate "file"

    for (let i = 0; i < totalParts; i++) {

        const start = i * PART_SIZE;

        const end = Math.min(start + PART_SIZE, f.size);

        const sliver = f.slice(start, end); // Logical slice (no RAM used yet)

        

        const partName = `${f.name}.part${i + 1}_of_${totalParts}`;

        const tid = Math.random().toString(36).substr(2, 5);



        // Convert slice to buffer for this specific part

        const buf = await sliver.arrayBuffer(); 

        const hashBuffer = await crypto.subtle.digest('SHA-256', buf);

        const fileHash = Array.from(new Uint8Array(hashBuffer)).map(b => b.toString(16).padStart(2, '0')).join('');



        createRow(tid, partName, 'SENDING');

        

        // Notify receiver about this specific part

        c.send({ 

            type: 'meta', 

            name: partName, 

            size: sliver.size, 

            tid: tid, 

            hash: fileHash 

        });



        let off = 0;

        while (off < sliver.size) {

            if (!c.open) break;

            // Backpressure check

            if (c.dataChannel.bufferedAmount > 1048576) { 

                await new Promise(r => setTimeout(r, 50)); 

                continue; 

            }

            c.send(buf.slice(off, off + CHUNK_SIZE));

            off += CHUNK_SIZE;

            updateUI(tid, off, sliver.size);

        }

        

        if (c.open) c.send({ type: 'eof', tid: tid });

        

        // Crucial: Wait 1 second between parts to let browser clear memory

        await new Promise(r => setTimeout(r, 1000));

    }

}


// --- RECEIVER (Handles parts individually for stability) ---
async function download(meta, c) {
    createRow(meta.tid, meta.name, 'RECEIVING');
    let chunks = [];

    const handler = async (data) => {
        if (data.type === 'eof' && data.tid === meta.tid) {
            c.off('data', handler);
            // Using RAM fallback because 250MB parts fit in memory easily
            finalizeRAM(meta.tid, meta.name, chunks, meta.hash, c);
            return;
        }
        if (data instanceof ArrayBuffer || data instanceof Uint8Array || data.byteLength !== undefined) {
            chunks.push(data);
            const currentTotal = chunks.reduce((a, b) => a + b.byteLength, 0);
            updateUI(meta.tid, currentTotal, meta.size);
        }
    };
    c.on('data', handler);
}

// Verification for Streaming
async function verifyLargeFile(handle, expectedHash, tid, c, name) {
    const tag = document.getElementById(`tag-${tid}`);
    tag.innerText = "VERIFYING...";
    const file = await handle.getFile();
    const actualBuf = await file.arrayBuffer();
    const hashBuffer = await crypto.subtle.digest('SHA-256', actualBuf);
    const actualHash = Array.from(new Uint8Array(hashBuffer)).map(b => b.toString(16).padStart(2, '0')).join('');

    if (actualHash !== expectedHash) {
        showRetry(tid, name, c);
    } else {
        tag.innerText = "DONE"; tag.style.color = "#8bc34a";
    }
}

// Verification for RAM Fallback
async function finalizeRAM(tid, name, chunks, expectedHash, c) {
    const tag = document.getElementById(`tag-${tid}`);
    tag.innerText = "VERIFYING...";
    const blob = new Blob(chunks);
    const actualBuf = await blob.arrayBuffer();
    const hashBuffer = await crypto.subtle.digest('SHA-256', actualBuf);
    const actualHash = Array.from(new Uint8Array(hashBuffer)).map(b => b.toString(16).padStart(2, '0')).join('');

    if (actualHash !== expectedHash) {
        showRetry(tid, name, c);
    } else {
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a'); a.href = url; a.download = name; a.click();
        tag.innerText = "DONE"; tag.style.color = "#8bc34a";
    }
}

function showRetry(tid, name, c) {
    const tag = document.getElementById(`tag-${tid}`);
    const perc = document.getElementById(`perc-${tid}`);
    tag.innerText = "CORRUPT"; tag.style.color = "#ff4444";
    perc.innerHTML = `<button class="btn" style="background:#f39c12; color:black; padding:2px 5px;" onclick="retryNow('${name}', '${c.peer}', '${tid}')">RETRY</button>`;
}

function retryNow(name, pid, oldTid) {
    document.getElementById(`row-${oldTid}`).remove();
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

