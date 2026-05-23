export interface BuiltinHookTemplate {
    id: string;
    name: string;
    description: string;
    category: string;
    tags: string[];
    script: string;
}

const wasmMemoryObserverScript = String.raw`(() => {
    const GUARD_KEY = "__wmpfWasmObserverInstalled__";
    const STATE_KEY = "__wmpfWasmObserver";
    const VERBOSE = false;
    const SAMPLE_LIMIT = 12;
    const SUMMARY_INTERVAL = 10;

    if (globalThis[GUARD_KEY]) {
        console.info("[WASM观察] 已安装，跳过重复注入");
        return;
    }
    globalThis[GUARD_KEY] = true;

    const originalInstantiate = WebAssembly.instantiate;
    const originalInstantiateStreaming = typeof WebAssembly.instantiateStreaming === "function"
        ? WebAssembly.instantiateStreaming
        : null;
    const observedMemories = new WeakSet();

    const state = {
        instantiateCount: 0,
        streamingCount: 0,
        memoryGrowCount: 0,
        latestInstance: null,
        latestMemory: null,
        latestExports: [],
        samples: [],
        verbose: VERBOSE,
        setVerbose(nextValue) {
            this.verbose = Boolean(nextValue);
            console.info("[WASM观察] verbose =", this.verbose);
        },
        dump() {
            return {
                instantiateCount: this.instantiateCount,
                streamingCount: this.streamingCount,
                memoryGrowCount: this.memoryGrowCount,
                latestExports: this.latestExports.slice(),
                sampleCount: this.samples.length,
                samples: this.samples.slice(-5),
                latestMemoryBytes: this.latestMemory ? this.latestMemory.buffer.byteLength : 0,
            };
        },
        getView() {
            if (!this.latestMemory) {
                throw new Error("当前没有可用的 WebAssembly.Memory");
            }
            return new DataView(this.latestMemory.buffer);
        },
        readU8(offset) {
            return this.getView().getUint8(offset);
        },
        readU16(offset, littleEndian = true) {
            return this.getView().getUint16(offset, littleEndian);
        },
        readU32(offset, littleEndian = true) {
            return this.getView().getUint32(offset, littleEndian);
        },
        readF32(offset, littleEndian = true) {
            return this.getView().getFloat32(offset, littleEndian);
        },
        readAscii(offset, length) {
            if (!this.latestMemory) {
                throw new Error("当前没有可用的 WebAssembly.Memory");
            }
            const bytes = new Uint8Array(this.latestMemory.buffer, offset, length);
            return Array.from(bytes).map((value) => String.fromCharCode(value)).join("");
        },
        readBytes(offset, length) {
            if (!Number.isInteger(length) || length <= 0) {
                throw new Error("length 必须是正整数");
            }
            if (!this.latestMemory) {
                throw new Error("当前没有可用的 WebAssembly.Memory");
            }
            return Array.from(new Uint8Array(this.latestMemory.buffer, offset, length));
        },
    };

    Object.defineProperty(globalThis, STATE_KEY, {
        value: state,
        configurable: true,
    });

    function pushSample(sample) {
        state.samples.push(sample);
        if (state.samples.length > SAMPLE_LIMIT) {
            state.samples.shift();
        }
    }

    function summarizeExports(instance) {
        if (!instance || !instance.exports) {
            return [];
        }
        return Object.keys(instance.exports).slice(0, 8);
    }

    function shouldLog(counter) {
        return state.verbose || counter === 1 || counter % SUMMARY_INTERVAL === 0;
    }

    function findMemory(instance) {
        if (!instance || !instance.exports) {
            return null;
        }
        for (const value of Object.values(instance.exports)) {
            if (value instanceof WebAssembly.Memory) {
                return value;
            }
        }
        return null;
    }

    function observeMemory(memory) {
        if (!memory || observedMemories.has(memory)) {
            return;
        }
        observedMemories.add(memory);
        state.latestMemory = memory;

        const originalGrow = memory.grow;
        memory.grow = function patchedGrow(...args) {
            const beforePages = memory.buffer.byteLength / 65536;
            const result = originalGrow.apply(this, args);
            const afterPages = memory.buffer.byteLength / 65536;
            state.memoryGrowCount += 1;

            const sample = {
                type: "memory.grow",
                beforePages,
                afterPages,
                beforeBytes: beforePages * 65536,
                afterBytes: afterPages * 65536,
                deltaPages: afterPages - beforePages,
                args,
                timestamp: Date.now(),
            };
            pushSample(sample);
            console.info("[WASM观察] memory.grow", sample);
            return result;
        };
    }

    function recordInstantiate(kind, result, sourceType) {
        const instance = result && result.instance ? result.instance : result;
        const memory = findMemory(instance);
        const exportNames = summarizeExports(instance);

        state.instantiateCount += 1;
        if (kind === "streaming") {
            state.streamingCount += 1;
        }
        state.latestInstance = instance || null;
        state.latestMemory = memory;
        state.latestExports = exportNames;

        if (memory) {
            observeMemory(memory);
        }

        const sample = {
            type: kind,
            sourceType,
            exportCount: exportNames.length,
            exportNames,
            hasMemory: Boolean(memory),
            memoryBytes: memory ? memory.buffer.byteLength : 0,
            timestamp: Date.now(),
        };
        pushSample(sample);

        if (shouldLog(state.instantiateCount)) {
            console.info("[WASM观察] 实例化摘要", sample);
        }
    }

    WebAssembly.instantiate = async function patchedInstantiate(bufferSource, importObject) {
        const result = await originalInstantiate.call(this, bufferSource, importObject);
        const sourceType = bufferSource && bufferSource.constructor ? bufferSource.constructor.name : typeof bufferSource;
        recordInstantiate("instantiate", result, sourceType);
        return result;
    };

    if (originalInstantiateStreaming) {
        WebAssembly.instantiateStreaming = async function patchedInstantiateStreaming(response, importObject) {
            const result = await originalInstantiateStreaming.call(this, response, importObject);
            const sourceType = response && response.constructor ? response.constructor.name : typeof response;
            recordInstantiate("streaming", result, sourceType);
            return result;
        };
    }

    console.info("[WASM观察] 模板已安装。可通过 globalThis.__wmpfWasmObserver 查看统计，并按需开启 verbose。");
})();`;

const loopObserverScript = String.raw`(() => {
    const GUARD_KEY = "__wmpfLoopObserverInstalled__";
    const STATE_KEY = "__wmpfLoopObserver";
    const VERBOSE = false;
    const SLOW_CALLBACK_MS = 16;
    const LONG_DELAY_MS = 1000;
    const SAMPLE_LIMIT = 20;
    const FIRING_SAMPLE_INTERVAL = 120;

    if (globalThis[GUARD_KEY]) {
        console.info("[循环观察] 已安装，跳过重复注入");
        return;
    }
    globalThis[GUARD_KEY] = true;

    const originalSetTimeout = globalThis.setTimeout;
    const originalClearTimeout = globalThis.clearTimeout;
    const originalSetInterval = globalThis.setInterval;
    const originalClearInterval = globalThis.clearInterval;
    const originalRequestAnimationFrame = typeof globalThis.requestAnimationFrame === "function"
        ? globalThis.requestAnimationFrame
        : null;
    const originalCancelAnimationFrame = typeof globalThis.cancelAnimationFrame === "function"
        ? globalThis.cancelAnimationFrame
        : null;

    const state = {
        verbose: VERBOSE,
        counters: {
            timeoutScheduled: 0,
            timeoutFired: 0,
            intervalScheduled: 0,
            intervalFired: 0,
            rafScheduled: 0,
            rafFired: 0,
            timeoutCleared: 0,
            intervalCleared: 0,
            rafCleared: 0,
        },
        activeTimeouts: new Map(),
        activeIntervals: new Map(),
        activeRafs: new Map(),
        slowSamples: [],
        lastDelays: [],
        setVerbose(nextValue) {
            this.verbose = Boolean(nextValue);
            console.info("[循环观察] verbose =", this.verbose);
        },
        dump() {
            return {
                counters: Object.assign({}, this.counters),
                activeTimeoutCount: this.activeTimeouts.size,
                activeIntervalCount: this.activeIntervals.size,
                activeRafCount: this.activeRafs.size,
                lastDelays: this.lastDelays.slice(-10),
                slowSamples: this.slowSamples.slice(-5),
            };
        },
    };

    Object.defineProperty(globalThis, STATE_KEY, {
        value: state,
        configurable: true,
    });

    let callbackIdCounter = 0;

    function callbackName(callback) {
        return callback && callback.name ? callback.name : "anonymous";
    }

    function pushBounded(list, value, limit) {
        list.push(value);
        if (list.length > limit) {
            list.shift();
        }
    }

    function shouldLog(counter, duration, delay) {
        if (state.verbose || counter === 1) {
            return true;
        }
        if (typeof delay === "number" && delay >= LONG_DELAY_MS) {
            return true;
        }
        if (typeof duration === "number" && duration >= SLOW_CALLBACK_MS) {
            return true;
        }
        return counter % FIRING_SAMPLE_INTERVAL === 0;
    }

    function wrapCallback(kind, callback, meta) {
        if (typeof callback !== "function") {
            return callback;
        }

        const callbackTag = kind + ":" + callbackName(callback) + ":" + (++callbackIdCounter);
        return function wrappedCallback(...args) {
            const startedAt = performance.now();
            try {
                return callback.apply(this, args);
            } finally {
                const duration = Number((performance.now() - startedAt).toFixed(3));
                const counterKey = kind + "Fired";
                state.counters[counterKey] += 1;

                const sample = {
                    kind,
                    callbackTag,
                    callbackName: callbackName(callback),
                    duration,
                    delay: meta.delay,
                    timestamp: Date.now(),
                };

                if (kind === "timeout") {
                    state.activeTimeouts.delete(meta.handleId);
                }
                if (shouldLog(state.counters[counterKey], duration, meta.delay)) {
                    console.info("[循环观察] 回调摘要", sample);
                }
                if (duration >= SLOW_CALLBACK_MS) {
                    pushBounded(state.slowSamples, sample, SAMPLE_LIMIT);
                }
            }
        };
    }

    globalThis.setTimeout = function patchedSetTimeout(callback, delay, ...args) {
        const normalizedDelay = Number(delay) || 0;
        pushBounded(state.lastDelays, normalizedDelay, 20);
        state.counters.timeoutScheduled += 1;

        let handleId = null;
        const wrapped = wrapCallback("timeout", callback, {
            delay: normalizedDelay,
            get handleId() {
                return handleId;
            },
        });
        handleId = originalSetTimeout.call(this, wrapped, delay, ...args);

        state.activeTimeouts.set(handleId, {
            delay: normalizedDelay,
            callbackName: callbackName(callback),
            createdAt: Date.now(),
        });

        if (shouldLog(state.counters.timeoutScheduled, null, normalizedDelay)) {
            console.info("[循环观察] setTimeout 注册", {
                handleId,
                delay: normalizedDelay,
                callbackName: callbackName(callback),
            });
        }
        return handleId;
    };

    globalThis.clearTimeout = function patchedClearTimeout(handleId) {
        if (state.activeTimeouts.has(handleId)) {
            state.counters.timeoutCleared += 1;
            state.activeTimeouts.delete(handleId);
        }
        return originalClearTimeout.call(this, handleId);
    };

    globalThis.setInterval = function patchedSetInterval(callback, delay, ...args) {
        const normalizedDelay = Number(delay) || 0;
        pushBounded(state.lastDelays, normalizedDelay, 20);
        state.counters.intervalScheduled += 1;

        let handleId = null;
        const wrapped = wrapCallback("interval", callback, {
            delay: normalizedDelay,
            get handleId() {
                return handleId;
            },
        });
        handleId = originalSetInterval.call(this, wrapped, delay, ...args);

        state.activeIntervals.set(handleId, {
            delay: normalizedDelay,
            callbackName: callbackName(callback),
            createdAt: Date.now(),
        });

        if (shouldLog(state.counters.intervalScheduled, null, normalizedDelay)) {
            console.info("[循环观察] setInterval 注册", {
                handleId,
                delay: normalizedDelay,
                callbackName: callbackName(callback),
            });
        }
        return handleId;
    };

    globalThis.clearInterval = function patchedClearInterval(handleId) {
        if (state.activeIntervals.has(handleId)) {
            state.counters.intervalCleared += 1;
            state.activeIntervals.delete(handleId);
        }
        return originalClearInterval.call(this, handleId);
    };

    if (originalRequestAnimationFrame) {
        globalThis.requestAnimationFrame = function patchedRequestAnimationFrame(callback) {
            state.counters.rafScheduled += 1;

            let handleId = null;
            const wrapped = wrapCallback("raf", callback, {
                delay: 0,
                get handleId() {
                    return handleId;
                },
            });
            handleId = originalRequestAnimationFrame.call(this, wrapped);

            state.activeRafs.set(handleId, {
                callbackName: callbackName(callback),
                createdAt: Date.now(),
            });

            if (shouldLog(state.counters.rafScheduled, null, 0)) {
                console.info("[循环观察] requestAnimationFrame 注册", {
                    handleId,
                    callbackName: callbackName(callback),
                });
            }
            return handleId;
        };
    }

    if (originalCancelAnimationFrame) {
        globalThis.cancelAnimationFrame = function patchedCancelAnimationFrame(handleId) {
            if (state.activeRafs.has(handleId)) {
                state.counters.rafCleared += 1;
                state.activeRafs.delete(handleId);
            }
            return originalCancelAnimationFrame.call(this, handleId);
        };
    }

    console.info("[循环观察] 模板已安装。可通过 globalThis.__wmpfLoopObserver 查看统计，并按需开启 verbose。");
})();`;

const wasmExportObserverScript = String.raw`(() => {
    const GUARD_KEY = "__wmpfWasmExportObserverInstalled__";
    const STATE_KEY = "__wmpfWasmExportObserver";
    const VERBOSE = false;
    const SAMPLE_LIMIT = 20;
    const MAX_WRAP_COUNT = 10;
    const INCLUDE_RE = /update|tick|step|loop|run|main|render|encrypt|decrypt|decode|encode|malloc|free/i;

    if (globalThis[GUARD_KEY]) {
        console.info("[WASM导出观察] 已安装，跳过重复注入");
        return;
    }
    globalThis[GUARD_KEY] = true;

    const originalInstantiate = WebAssembly.instantiate;
    const originalInstantiateStreaming = typeof WebAssembly.instantiateStreaming === "function"
        ? WebAssembly.instantiateStreaming
        : null;
    const wrappedFunctions = new WeakSet();

    const state = {
        verbose: VERBOSE,
        instantiateCount: 0,
        wrappedExportNames: [],
        callCountByName: Object.create(null),
        lastCallSamples: [],
        latestInstance: null,
        setVerbose(nextValue) {
            this.verbose = Boolean(nextValue);
            console.info("[WASM导出观察] verbose =", this.verbose);
        },
        dump() {
            return {
                instantiateCount: this.instantiateCount,
                wrappedExportNames: this.wrappedExportNames.slice(),
                callCountByName: Object.assign({}, this.callCountByName),
                lastCallSamples: this.lastCallSamples.slice(-8),
            };
        },
    };

    Object.defineProperty(globalThis, STATE_KEY, {
        value: state,
        configurable: true,
    });

    function pushSample(sample) {
        state.lastCallSamples.push(sample);
        if (state.lastCallSamples.length > SAMPLE_LIMIT) {
            state.lastCallSamples.shift();
        }
    }

    function summarizeArgs(args) {
        return args.slice(0, 6).map((value) => {
            if (typeof value === "number" || typeof value === "boolean" || typeof value === "string") {
                return value;
            }
            if (value === null || value === undefined) {
                return value;
            }
            if (ArrayBuffer.isView(value)) {
                return { type: value.constructor.name, length: value.byteLength || value.length || 0 };
            }
            if (value instanceof ArrayBuffer) {
                return { type: "ArrayBuffer", length: value.byteLength };
            }
            return Object.prototype.toString.call(value);
        });
    }

    function shouldWrap(name) {
        return INCLUDE_RE.test(name);
    }

    function shouldLog(name, count, duration) {
        return state.verbose || count === 1 || duration >= 8 || /tick|step|loop|render/i.test(name) && count % 120 === 0;
    }

    function wrapExports(instance) {
        if (!instance || !instance.exports) {
            return;
        }

        const names = Object.keys(instance.exports);
        const candidates = names.filter((name) => typeof instance.exports[name] === "function" && shouldWrap(name)).slice(0, MAX_WRAP_COUNT);
        state.wrappedExportNames = candidates.slice();

        candidates.forEach((name) => {
            const original = instance.exports[name];
            if (wrappedFunctions.has(original)) {
                return;
            }
            wrappedFunctions.add(original);

            instance.exports[name] = function wrappedExport(...args) {
                const startedAt = performance.now();
                try {
                    return original.apply(this, args);
                } finally {
                    const duration = Number((performance.now() - startedAt).toFixed(3));
                    state.callCountByName[name] = (state.callCountByName[name] || 0) + 1;
                    const count = state.callCountByName[name];
                    const sample = {
                        name,
                        count,
                        duration,
                        args: summarizeArgs(args),
                        timestamp: Date.now(),
                    };
                    pushSample(sample);
                    if (shouldLog(name, count, duration)) {
                        console.info("[WASM导出观察] 调用摘要", sample);
                    }
                }
            };
        });

        if (candidates.length > 0) {
            console.info("[WASM导出观察] 已包装导出", candidates);
        } else {
            console.info("[WASM导出观察] 未命中候选导出，可自行调整 INCLUDE_RE");
        }
    }

    function afterInstantiate(result) {
        const instance = result && result.instance ? result.instance : result;
        state.instantiateCount += 1;
        state.latestInstance = instance || null;
        wrapExports(instance);
    }

    WebAssembly.instantiate = async function patchedInstantiate(bufferSource, importObject) {
        const result = await originalInstantiate.call(this, bufferSource, importObject);
        afterInstantiate(result);
        return result;
    };

    if (originalInstantiateStreaming) {
        WebAssembly.instantiateStreaming = async function patchedInstantiateStreaming(response, importObject) {
            const result = await originalInstantiateStreaming.call(this, response, importObject);
            afterInstantiate(result);
            return result;
        };
    }

    console.info("[WASM导出观察] 模板已安装。可通过 globalThis.__wmpfWasmExportObserver.dump() 查看统计。");
})();`;

const binaryResourceObserverScript = String.raw`(() => {
    const GUARD_KEY = "__wmpfBinaryResourceObserverInstalled__";
    const STATE_KEY = "__wmpfBinaryResourceObserver";
    const VERBOSE = false;
    const SAMPLE_LIMIT = 24;
    const LOG_SIZE_THRESHOLD = 32768;

    if (globalThis[GUARD_KEY]) {
        console.info("[资源观察] 已安装，跳过重复注入");
        return;
    }
    globalThis[GUARD_KEY] = true;

    const originalFetch = typeof globalThis.fetch === "function" ? globalThis.fetch : null;
    const originalOpen = typeof XMLHttpRequest !== "undefined" ? XMLHttpRequest.prototype.open : null;
    const originalSend = typeof XMLHttpRequest !== "undefined" ? XMLHttpRequest.prototype.send : null;
    const originalWebSocket = typeof WebSocket === "function" ? WebSocket : null;

    const state = {
        verbose: VERBOSE,
        fetchCount: 0,
        xhrCount: 0,
        wsConstructCount: 0,
        wsSendCount: 0,
        samples: [],
        setVerbose(nextValue) {
            this.verbose = Boolean(nextValue);
            console.info("[资源观察] verbose =", this.verbose);
        },
        dump() {
            return {
                fetchCount: this.fetchCount,
                xhrCount: this.xhrCount,
                wsConstructCount: this.wsConstructCount,
                wsSendCount: this.wsSendCount,
                samples: this.samples.slice(-10),
            };
        },
    };

    Object.defineProperty(globalThis, STATE_KEY, {
        value: state,
        configurable: true,
    });

    function pushSample(sample) {
        state.samples.push(sample);
        if (state.samples.length > SAMPLE_LIMIT) {
            state.samples.shift();
        }
    }

    function describeBinary(value) {
        if (value instanceof ArrayBuffer) {
            return { type: "ArrayBuffer", length: value.byteLength };
        }
        if (ArrayBuffer.isView(value)) {
            return { type: value.constructor.name, length: value.byteLength || value.length || 0 };
        }
        if (typeof Blob === "function" && value instanceof Blob) {
            return { type: "Blob", length: value.size };
        }
        if (typeof value === "string") {
            return { type: "string", length: value.length };
        }
        if (value && typeof value === "object") {
            return { type: Object.prototype.toString.call(value) };
        }
        return { type: typeof value };
    }

    function shouldLog(sample) {
        if (state.verbose) {
            return true;
        }
        if (sample.kind === "fetch" && state.fetchCount === 1) {
            return true;
        }
        if (sample.kind === "xhr" && state.xhrCount === 1) {
            return true;
        }
        return Boolean(sample.size && sample.size >= LOG_SIZE_THRESHOLD);
    }

    if (originalFetch) {
        globalThis.fetch = async function patchedFetch(input, init) {
            const url = typeof input === "string" ? input : input && input.url ? input.url : String(input);
            const method = init && init.method ? init.method : "GET";
            const response = await originalFetch.call(this, input, init);
            state.fetchCount += 1;

            const contentLength = Number(response.headers.get("content-length") || 0);
            const sample = {
                kind: "fetch",
                url,
                method,
                status: response.status,
                contentType: response.headers.get("content-type") || "",
                size: contentLength,
                count: state.fetchCount,
                timestamp: Date.now(),
            };
            pushSample(sample);
            if (shouldLog(sample)) {
                console.info("[资源观察] fetch 摘要", sample);
            }
            return response;
        };
    }

    if (originalOpen && originalSend) {
        XMLHttpRequest.prototype.open = function patchedOpen(method, url, ...rest) {
            this.__wmpfObserverMeta = { method, url, startedAt: Date.now() };
            return originalOpen.call(this, method, url, ...rest);
        };

        XMLHttpRequest.prototype.send = function patchedSend(body) {
            const meta = this.__wmpfObserverMeta || { method: "GET", url: "" };
            const bodyInfo = describeBinary(body);
            this.addEventListener("loadend", () => {
                state.xhrCount += 1;
                const sample = {
                    kind: "xhr",
                    method: meta.method,
                    url: meta.url,
                    status: this.status,
                    responseType: this.responseType || "text",
                    requestBody: bodyInfo,
                    responseSize: Number(this.getResponseHeader("content-length") || 0),
                    count: state.xhrCount,
                    timestamp: Date.now(),
                };
                pushSample(sample);
                if (shouldLog(sample)) {
                    console.info("[资源观察] xhr 摘要", sample);
                }
            }, { once: true });
            return originalSend.call(this, body);
        };
    }

    if (originalWebSocket) {
        globalThis.WebSocket = function PatchedWebSocket(url, protocols) {
            const ws = protocols === undefined ? new originalWebSocket(url) : new originalWebSocket(url, protocols);
            state.wsConstructCount += 1;
            console.info("[资源观察] WebSocket 创建", {
                url,
                protocols: protocols || null,
                count: state.wsConstructCount,
            });

            const originalSend = ws.send;
            ws.send = function patchedSend(data) {
                state.wsSendCount += 1;
                const sample = {
                    kind: "ws.send",
                    url,
                    payload: describeBinary(data),
                    count: state.wsSendCount,
                    timestamp: Date.now(),
                };
                pushSample(sample);
                if (shouldLog(sample)) {
                    console.info("[资源观察] WebSocket send", sample);
                }
                return originalSend.call(this, data);
            };

            ws.addEventListener("message", (event) => {
                const sample = {
                    kind: "ws.message",
                    url,
                    payload: describeBinary(event.data),
                    timestamp: Date.now(),
                };
                pushSample(sample);
                if (shouldLog(sample)) {
                    console.info("[资源观察] WebSocket message", sample);
                }
            });

            return ws;
        };
        globalThis.WebSocket.prototype = originalWebSocket.prototype;
    }

    console.info("[资源观察] 模板已安装。可通过 globalThis.__wmpfBinaryResourceObserver.dump() 查看摘要。");
})();`;

const builtinTemplates: BuiltinHookTemplate[] = [
    {
        id: "builtin-wasm-memory-observer",
        name: "WASM / 内存观察模板",
        description: "观察 WebAssembly 实例化、导出摘要和 memory.grow，并提供内存读取辅助。",
        category: "逆向观察",
        tags: ["WASM", "内存", "小游戏", "观察"],
        script: wasmMemoryObserverScript,
    },
    {
        id: "builtin-loop-observer",
        name: "帧循环 / 定时器观察模板",
        description: "观察 requestAnimationFrame、setTimeout、setInterval 的注册与触发摘要。",
        category: "逆向观察",
        tags: ["帧循环", "定时器", "小游戏", "观察"],
        script: loopObserverScript,
    },
    {
        id: "builtin-wasm-export-observer",
        name: "WASM 导出调用观察模板",
        description: "按常见导出名自动包裹 tick、update、encrypt 等函数，统计调用频率、耗时和参数摘要。",
        category: "逆向观察",
        tags: ["WASM", "导出函数", "调用观察", "小游戏"],
        script: wasmExportObserverScript,
    },
    {
        id: "builtin-binary-resource-observer",
        name: "二进制资源 / 网络观察模板",
        description: "观察 fetch、XHR、WebSocket 的二进制资源流，快速定位 wasm、包体和高频网络通道。",
        category: "逆向观察",
        tags: ["网络", "二进制", "fetch", "WebSocket", "WASM"],
        script: binaryResourceObserverScript,
    },
];

export function getBuiltinHookTemplates(): BuiltinHookTemplate[] {
    return builtinTemplates.map((template) => ({
        ...template,
        tags: template.tags.slice(),
    }));
}

export function getBuiltinHookTemplateById(templateId: string): BuiltinHookTemplate | null {
    const template = builtinTemplates.find((item) => item.id === templateId);
    if (!template) {
        return null;
    }

    return {
        ...template,
        tags: template.tags.slice(),
    };
}
