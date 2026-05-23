const VERBOSE = false;
const CDP_FILTER_SUMMARY_INTERVAL = 200;
const SCENE_SUMMARY_INTERVAL = 20;

const stats = {
    cdpFilterEnterCount: 0,
    cdpFilterPatchCount: 0,
    cdpFilterNullCount: 0,
    sceneObservedCount: 0,
    scenePatchedCount: 0,
};

const sceneSampleCounts = Object.create(null);

const shouldLogSummary = (count, interval) => count === 1 || count % interval === 0;

const logCdpFilterSummary = (reason) => {
    send(
        `[patch] CDP filter summary (${reason}): ` +
            `enter=${stats.cdpFilterEnterCount}, ` +
            `patched=${stats.cdpFilterPatchCount}, ` +
            `null=${stats.cdpFilterNullCount}`,
    );
};

const logSceneSummary = (scene, reason) => {
    send(
        `[hook] scene summary (${reason}): ` +
            `scene=${scene}, ` +
            `observed=${stats.sceneObservedCount}, ` +
            `patched=${stats.scenePatchedCount}, ` +
            `sceneHits=${sceneSampleCounts[scene] || 0}`,
    );
};

const getMainModule = (version) => {
    if (version >= 13331) {
        return Process.findModuleByName("flue.dll");
    }
    return Process.findModuleByName("WeChatAppEx.exe");
};

const patchCDPFilter = (base, config) => {
    // xref: SendToClientFilter OR devtools_message_filter_applet_webview.cc
    const offset = config.CDPFilterHookOffset;
    send(
        `[patch] CDP filter installed at ${offset}; ` +
            `verbose=${VERBOSE ? "on" : "off"}, detail logs suppressed by default`,
    );
    Interceptor.attach(base.add(offset), {
        onEnter(args) {
            stats.cdpFilterEnterCount += 1;
            if (VERBOSE) {
                send(
                    `[patch] CDP filter on enter, original value of input: ${args[0].readPointer()}`,
                );
            } else if (shouldLogSummary(stats.cdpFilterEnterCount, CDP_FILTER_SUMMARY_INTERVAL)) {
                logCdpFilterSummary("enter");
            }
            this.inputValue = args[0];
        },
        onLeave(retval) {
            const inputValue = this.inputValue.readPointer();
            if (inputValue.isNull() || inputValue.add(8).isNull()) {
                // there's a chance the value could be null
                // return here to avoid crash
                stats.cdpFilterNullCount += 1;
                if (VERBOSE) {
                    send("[patch] CDP filter skipped null input");
                }
                return;
            }

            if (inputValue.add(8).readU32() == 6) {
                stats.cdpFilterPatchCount += 1;
                if (VERBOSE) {
                    send(
                        `[patch] CDP filter on leave, patch input, now value: ${inputValue}; ` +
                            `*(input + 8) = ${inputValue.add(8).readU32()}`,
                    );
                } else if (shouldLogSummary(stats.cdpFilterPatchCount, CDP_FILTER_SUMMARY_INTERVAL)) {
                    logCdpFilterSummary("patched");
                }
                inputValue.add(8).writeU32(0x0);
            }
        },
    });
};

const hookOnLoadScene = (a1, sceneOffsets) => {
    if (!Array.isArray(sceneOffsets) || sceneOffsets.length < 6) {
        throw new Error(
            `[config] SceneOffsets must contain 6 numbers, got: ${JSON.stringify(sceneOffsets)}`,
        );
    }

    const miniappConfigPtr = a1
        .add(sceneOffsets[0])
        .readPointer()
        .add(sceneOffsets[1])
        .readPointer();
    const miniappScenePtr = miniappConfigPtr
        .add(sceneOffsets[2])
        .readPointer()
        .add(sceneOffsets[3])
        .readPointer()
        .add(sceneOffsets[4])
        .readPointer()
        .add(sceneOffsets[5]);
    const scene = miniappScenePtr.readInt();
    stats.sceneObservedCount += 1;
    sceneSampleCounts[scene] = (sceneSampleCounts[scene] || 0) + 1;
    if (VERBOSE) {
        send(`[hook] scene: ${scene}`);
    } else if (shouldLogSummary(sceneSampleCounts[scene], SCENE_SUMMARY_INTERVAL)) {
        logSceneSummary(scene, "observed");
    }

    // 1000: from issue #83 <-- will crash the process
    // 1007: from issue #80
    // 1008: from issue #53
    // 1027: from issue #78
    // 1035: from issue #78
    // 1053: from issue #25
    // 1074: from issue #32
    // 1145: from search
    // 1178: from phone (issue #117)
    // 1256: from recent
    // 1260: from frequently used
    // 1302: from services
    // 1308: minigame?
    const sceneNumberArray = [
        1005, 1007, 1008, 1027, 1035, 1053, 1074, 1145, 1178, 1256, 1260, 1302,
        1308,
    ];
    if (!sceneNumberArray.includes(scene)) {
        return;
    }
    stats.scenePatchedCount += 1;
    if (VERBOSE) {
        send("[hook] hook scene condition -> 1101");
    } else if (shouldLogSummary(stats.scenePatchedCount, SCENE_SUMMARY_INTERVAL)) {
        logSceneSummary(scene, "patched");
    }
    miniappScenePtr.writeInt(1101);

    // TODO: customize debugging endpoint
    // const websocketServerStringPtr = passArgs.add(8).readPointer().add(520);
    // VERBOSE && console.log("[hook] hook websocket server, original: ", websocketServerStringPtr.readUtf8String());
    // websocketServerStringPtr.writeUtf8String("ws://127.0.0.1:8189/");
};

const patchOnLoadStart = (base, config) => {
    // xref: AppletIndexContainer::OnLoadStart
    Interceptor.attach(base.add(config.LoadStartHookOffset), {
        onEnter(args) {
            send(
                `[interceptor] AppletIndexContainer::OnLoadStart onEnter, ` +
                    `indexContainer.this: ${this.context.rcx}`,
            );
            // write dl to 0x1
            if ((this.context.rdx & 0xff) !== 1) {
                this.context.rdx = (this.context.rdx & ~0xff) | 0x1;
            }
            // handle onLoad scene
            hookOnLoadScene(this.context.rcx, config.SceneOffsets);
        },
        onLeave(retval) {
            // do nothing
        },
    });
};

const parseConfig = () => {
    const rawConfig = `@@CONFIG@@`;
    if (rawConfig.includes("@@")) {
        // test addresses
        return {
            Version: 18955,
            LoadStartHookOffset: "0x25B52C0",
            CDPFilterHookOffset: "0x30248B0",
            SceneOffsets: [56, 1408, 8, 1344, 16, 488],
        };
    }
    return JSON.parse(rawConfig);
};

const main = () => {
    const config = parseConfig();
    const mainModule = getMainModule(config.Version);
    if (!mainModule) {
        const moduleName =
            config.Version >= 13331 ? "flue.dll" : "WeChatAppEx.exe";
        throw new Error(`[hook] target module not found: ${moduleName}`);
    }
    patchOnLoadStart(mainModule.base, config);
    patchCDPFilter(mainModule.base, config);
};

main();
