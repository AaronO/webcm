
// OWC JS SDK

export class WebContainer {
    constructor(vmClient) {
        this.vmClient = vmClient;
        this.fs = new FileSystemAPI(vmClient);
        this.listeners = {};
        this.listeningPorts = new Set();
        this._startPortPolling();
    }

    static async boot(options = {}) {
        // Initialize webcm
        // We assume webcm.mjs is available or passed in options
        // For now, we'll assume the user has loaded webcm and we just wrap the Module
        // But the API says boot() returns a Promise<WebContainer>

        // We need to load webcm.mjs dynamically or assume it's global?
        // Let's assume we are running in a context where we can import it or it's passed.
        // Since we are making an SDK, we should probably let the user provide the module or init function.
        // But to be compatible, boot() should do it.

        // For this proof of concept, we'll assume `initEmscripten` is available globally or we import it.
        // Let's try to import it from relative path if possible, or expect it to be loaded.

        // Actually, to make it truly compatible, we might need to bundle webcm.
        // For now, let's allow passing the Module or init function in options for flexibility.

        const { wasmUrl, scriptUrl } = options;

        // This is a simplified boot. In a real SDK we'd handle loading the script and wasm.
        // We'll assume the user has set up the environment or we use default paths.

        let Module;
        if (options.module) {
            Module = options.module;
        } else if (window.Module) {
            Module = window.Module;
        } else {
            // Fallback or error
            throw new Error("WebCM Module not initialized. Please pass 'module' in options or load webcm.mjs first.");
        }

        const vmClient = new VmClient(Module);
        return new WebContainer(vmClient);
    }

    async run(command, args = [], options = {}) {
        const proc = await this.spawn(command, args, options);
        await proc.wait();
        proc.output.values

    }

    async spawn(command, args = [], options = {}) {
        const { env, terminal } = options;
        const body = {
            command,
            args,
            env,
            terminal
        };

        const res = await this.vmClient.fetch('http://api.owc/spawn', {
            method: 'POST',
            body: JSON.stringify(body)
        });

        if (!res.ok) {
            throw new Error(`Failed to spawn: ${await res.text()}`);
        }

        const { pid } = await res.json();
        return new WebContainerProcess(this.vmClient, pid);
    }

    async mount(tree, options) {
        // Recursively walk the tree and upload files
        // This is inefficient for large trees but works for PoC
        await this._uploadTree(tree, options?.mountPoint || '/');
    }

    async _uploadTree(tree, currentPath) {
        for (const [name, node] of Object.entries(tree)) {
            const path = `${currentPath}/${name}`.replace('//', '/');
            if (node.file) {
                let contents = node.file.contents;
                if (typeof contents === 'string') {
                    contents = new TextEncoder().encode(contents);
                }
                await this.fs.writeFile(path, contents);
            } else if (node.directory) {
                await this.fs.mkdir(path, { recursive: true });
                await this._uploadTree(node.directory, path);
            }
        }
    }

    on(event, listener) {
        if (!this.listeners[event]) {
            this.listeners[event] = [];
        }
        this.listeners[event].push(listener);
        return () => {
            this.listeners[event] = this.listeners[event].filter(l => l !== listener);
        };
    }

    _emit(event, ...args) {
        if (this.listeners[event]) {
            this.listeners[event].forEach(listener => listener(...args));
        }
    }

    async _startPortPolling() {
        while (true) { // TODO: Add stop condition on teardown
            try {
                const data = await this.fs.readFile('/proc/net/tcp', 'utf-8');
                this._parseTcpPorts(data);
            } catch (e) {
                // Ignore errors (e.g. file not found yet)
            }
            await new Promise(r => setTimeout(r, 1000));
        }
    }

    _parseTcpPorts(data) {
        const ports = new Set();
        const lines = data.split('\n').slice(1); // Skip header
        for (const line of lines) {
            const parts = line.trim().split(/\s+/);
            if (parts.length < 4) continue;

            const localAddress = parts[1];
            const state = parts[3];

            if (state === '0A') { // LISTEN
                const [ipHex, portHex] = localAddress.split(':');
                const port = parseInt(portHex, 16);

                // Parse IP address (little-endian hex)
                // 00000000 = 0.0.0.0
                // 0100007F = 127.0.0.1 (7F.00.00.01 in little-endian)
                // FEFE7F7F = 127.254.254.254 (7F.FE.FE.FE in little-endian) - exclude this!

                // Only emit for 0.0.0.0 or 127.0.0.1 (not other 127.x.x.x addresses)
                const isAnyAddress = ipHex === '00000000';
                const isLocalhost = ipHex === '0100007F';

                if ((isAnyAddress || isLocalhost) && !ports.has(port)) {
                    ports.add(port);
                }
            }
        }
        // Update active port set
        const oldPorts = this.listeningPorts;
        this.listeningPorts = ports;
        // Closed ports
        for (const port of oldPorts) {
            if (!ports.has(port)) {
                this._emit('port', port, 'close', `http://localhost:${port}`);
                this._emit('server-closed', port); // NOTE: OG webcontainers.io API doesn't emit this
            }
        }
        // New ports
        for (const port of ports) {
            if (!oldPorts.has(port)) {
                this._emit('port', port, 'open', `http://localhost:${port}`);
                this._emit('server-ready', port, `http://localhost:${port}`);
            }
        }
    }

    async teardown() {
        // TODO
    }
}

class FileSystemAPI {
    constructor(vmClient) {
        this.vmClient = vmClient;
    }

    async readFile(path, encoding) {
        const res = await this.vmClient.fetch(`http://api.owc/fs/read?path=${encodeURIComponent(path)}`);
        if (!res.ok) throw new Error(`readFile failed: ${res.statusText}`);

        const buffer = await res.arrayBuffer();
        const data = new Uint8Array(buffer);

        if (encoding === 'utf-8' || encoding === 'utf8') {
            return new TextDecoder().decode(data);
        }
        return data;
    }

    async writeFile(path, data, options) {
        const res = await this.vmClient.fetch(`http://api.owc/fs/write?path=${encodeURIComponent(path)}`, {
            method: 'POST',
            body: data
        });
        if (!res.ok) throw new Error(`writeFile failed: ${res.statusText}`);
    }

    async mkdir(path, options) {
        const res = await this.vmClient.fetch(`http://api.owc/fs/mkdir?path=${encodeURIComponent(path)}`, {
            method: 'POST'
        });
        if (!res.ok) throw new Error(`mkdir failed: ${res.statusText}`);
    }

    async rm(path, options) {
        const recursive = options?.recursive ? 'true' : 'false';
        const res = await this.vmClient.fetch(`http://api.owc/fs/rm?path=${encodeURIComponent(path)}&recursive=${recursive}`, {
            method: 'POST'
        });
        if (!res.ok) throw new Error(`rm failed: ${res.statusText}`);
    }

    async readdir(path, options) {
        const withFileTypes = options?.withFileTypes ? 'true' : 'false';
        const res = await this.vmClient.fetch(`http://api.owc/fs/readdir?path=${encodeURIComponent(path)}&withFileTypes=${withFileTypes}`);
        if (!res.ok) throw new Error(`readdir failed: ${res.statusText}`);
        return await res.json();
    }
}

class WebContainerProcess {
    constructor(vmClient, pid) {
        this.vmClient = vmClient;
        this.pid = pid;

        this.output = new ReadableStream({
            start: (controller) => {
                this._pollOutput(controller);
            },
            cancel: () => {
                this._stopPolling = true;
            }
        });

        this.input = new WritableStream({
            write: async (chunk) => {
                await this.vmClient.fetch(`http://api.owc/process/input?pid=${this.pid}`, {
                    method: 'POST',
                    body: chunk
                });
            }
        });

        this._exitPromise = new Promise((resolve) => {
            this._resolveExit = resolve;
        });
    }

    get exit() {
        return this._exitPromise;
    }

    async _pollOutput(controller) {
        while (!this._stopPolling) {
            try {
                const res = await this.vmClient.fetch(`http://api.owc/process/output?pid=${this.pid}`);
                if (res.ok) {
                    const text = await res.text();
                    if (text.length > 0) {
                        controller.enqueue(text);
                    }
                } else if (res.status === 404) {
                    // Process gone
                    this._stopPolling = true;
                    controller.close();
                    this._resolveExit(0); // Assume success for now, need exit code API
                    return;
                }
            } catch (e) {
                console.error("Polling error", e);
            }
            await new Promise(r => setTimeout(r, 100)); // Poll interval
        }
    }

    resize(dimensions) {
        this.vmClient.fetch(`http://api.owc/process/resize?pid=${this.pid}&cols=${dimensions.cols}&rows=${dimensions.rows}`, {
            method: 'POST'
        });
    }

    kill() {
        this.vmClient.fetch(`http://api.owc/kill?pid=${this.pid}`, {
            method: 'POST'
        });
    }
}

class VmClient {
    constructor(Module) {
        this.Module = Module;
        this._installJsBridge();
    }

    _installJsBridge() {
        if (!this.Module._pendingResponses) {
            this.Module._pendingResponses = new Map();
        }
    }

    // Copied and adapted from index.html
    async fetch(url, options = {}) {
        const method = (options.method || 'GET').toUpperCase();
        const headers = options.headers || {};
        const body = options.body || null;

        // Prepare body
        let bodyData = null;
        let contentType = null;

        if (body) {
            if (typeof body === 'string') {
                bodyData = new TextEncoder().encode(body);
            } else if (body instanceof Uint8Array) {
                bodyData = body;
            } else {
                bodyData = new TextEncoder().encode(JSON.stringify(body));
                contentType = 'application/json';
            }
        }

        // Prepare headers
        let headersStr = '';
        if (headers) {
            headersStr = Object.entries(headers).map(([k, v]) => `${k}: ${v}`).join('\n');
        }
        if (contentType && !headersStr.toLowerCase().includes('content-type:')) {
            headersStr = `Content-Type: ${contentType}\n${headersStr}`;
        }

        // Copy body into WASM memory if present
        // Copy body into WASM memory if present
        let bodyPtr = 0;
        if (bodyData && bodyData.length > 0) {
            bodyPtr = this.Module._malloc(bodyData.length);

            // Refresh HEAPU8 view after malloc in case of resize
            let heapU8 = this.Module.HEAPU8;
            if (!heapU8 || heapU8.buffer.byteLength === 0) {
                if (this.Module.HEAP8) {
                    heapU8 = new Uint8Array(this.Module.HEAP8.buffer);
                } else if (this.Module.wasmMemory) {
                    heapU8 = new Uint8Array(this.Module.wasmMemory.buffer);
                }
            }
            if (!heapU8) {
                this.Module._free(bodyPtr);
                throw new Error('WASM heap not available on Module (expected HEAPU8)');
            }

            heapU8.set(bodyData, bodyPtr);
        }

        // Call VM
        let uid;
        try {
            uid = this.Module.ccall('vmFetch', 'number',
                ['string', 'string', 'string', 'number', 'number'],
                [url, method, headersStr || null, bodyData?.length || 0, bodyPtr]);
        } catch (e) {
            if (bodyPtr) {
                this.Module._free(bodyPtr);
            }
            throw new Error('Failed to queue request: ' + e.message);
        }
        if (bodyPtr) {
            this.Module._free(bodyPtr);
        }

        // Poll for response
        return new Promise((resolve, reject) => {
            const poll = () => {
                if (this.Module.ccall('prepare_reverse_response', 'number', ['number'], [uid])) {
                    const responseData = this.Module._pendingResponses.get(Number(uid));
                    this.Module._pendingResponses.delete(Number(uid));

                    if (!responseData) {
                        reject(new Error('Failed to fetch'));
                        return;
                    }

                    const response = new Response(responseData.body, {
                        status: responseData.status,
                        headers: responseData.headers
                    });
                    resolve(response);
                } else {
                    setTimeout(poll, 10);
                }
            };
            poll();
        });
    }
}
