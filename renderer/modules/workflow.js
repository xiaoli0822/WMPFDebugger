export function createWorkflowModule(options) {
    const {
        badge,
        tip,
        stepProcessRow,
        stepServiceRow,
        stepDevtoolsRow,
        stepProcess,
        stepService,
        stepDevtools,
        debugPortInput,
        cdpPortInput,
        formatErrorMessage,
    } = options;

    function update(state) {
        const {
            isScanningProcesses,
            processScanError,
            processRecords,
            isRunning,
        } = state;

        if (isScanningProcesses) {
            badge.textContent = "扫描中";
            tip.textContent = "正在扫描 WMPF 进程，用于确认环境是否就绪。";
            stepProcess.textContent = "正在扫描活跃的 WMPF 进程...";
            setWorkflowStepState(stepProcessRow, "current");
            setWorkflowStepState(stepServiceRow, null);
            setWorkflowStepState(stepDevtoolsRow, null);
            stepService.textContent = "扫描完成后可启动服务。";
            stepDevtools.textContent = "调试服务运行后可用。";
            return;
        }

        if (processScanError) {
            badge.textContent = "扫描失败";
            tip.textContent = "进程扫描失败。请查看日志详情，重新扫描后再启动服务。";
            stepProcess.textContent = `扫描失败：${formatErrorMessage(processScanError)}`;
            stepService.textContent = "请先修复扫描问题，再启动服务。";
            stepDevtools.textContent = "等待服务可用。";
            setWorkflowStepState(stepProcessRow, "error");
            setWorkflowStepState(stepServiceRow, null);
            setWorkflowStepState(stepDevtoolsRow, null);
            return;
        }

        if (processRecords.length === 0) {
            badge.textContent = "等待目标应用";
            tip.textContent = "请先打开微信小程序。检测到 WMPF 进程后即可启动调试服务。";
            stepProcess.textContent = "暂未检测到活跃的 WMPF 进程。";
            stepService.textContent = "等待目标进程后再启动。";
            stepDevtools.textContent = "服务运行后再打开 DevTools。";
            setWorkflowStepState(stepProcessRow, "current");
            setWorkflowStepState(stepServiceRow, null);
            setWorkflowStepState(stepDevtoolsRow, null);
            return;
        }

        if (!isRunning) {
            badge.textContent = "可以启动";
            tip.textContent = "已检测到 WMPF。确认端口后即可启动调试服务。";
            stepProcess.textContent = `已检测到 ${processRecords.length} 个 WMPF 进程。`;
            stepService.textContent = "端口已就绪。点击“启动”后会附加 Frida 并启动代理。";
            stepDevtools.textContent = "服务显示运行中后即可打开 DevTools。";
            setWorkflowStepState(stepProcessRow, "complete");
            setWorkflowStepState(stepServiceRow, "current");
            setWorkflowStepState(stepDevtoolsRow, null);
            return;
        }

        badge.textContent = "可打开 DevTools";
        tip.textContent = "调试服务正在运行。现在可以打开 DevTools；插件变更后请重新打开或刷新。";
        stepProcess.textContent = `已检测到 ${processRecords.length} 个 WMPF 进程。`;
        stepService.textContent = `服务运行中，调试端口 ${debugPortInput.value} / CDP ${cdpPortInput.value}。`;
        stepDevtools.textContent = "现在可以打开 DevTools。插件变更后重新打开以应用 Hook。";
        setWorkflowStepState(stepProcessRow, "complete");
        setWorkflowStepState(stepServiceRow, "complete");
        setWorkflowStepState(stepDevtoolsRow, "current");
    }

    function setWorkflowStepState(element, state) {
        element.classList.remove("complete", "current", "error");
        if (state) {
            element.classList.add(state);
        }
    }

    return {
        update,
    };
}
