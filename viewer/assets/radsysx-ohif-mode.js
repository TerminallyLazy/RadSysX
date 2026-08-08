// @ts-check

(function radsysxOHIFMode() {
  /** @type {any} */ (window).__RADSYSX_OHIF_MODE__ = {
    id: "@radsysx/mode-clinical",
    async modeFactory({ modeConfiguration, loadModules }) {
      const [longitudinalMode] = await loadModules(["@ohif/mode-longitudinal"]);
      const baseMode = longitudinalMode.modeFactory({ modeConfiguration });
      const workspacePanel = "@radsysx/extension-clinical.panelModule.workspace";
      const aiChatPanel = "@radsysx/extension-clinical.panelModule.aiChat";
      const baseRoute = baseMode.routes?.[0];
      const originalOnModeInit = baseMode.onModeInit?.bind(baseMode);
      const originalOnModeEnter = baseMode.onModeEnter?.bind(baseMode);

      return {
        ...baseMode,
        id: "@radsysx/mode-clinical",
        routeName: "",
        displayName: "RadSysX Clinical Viewer",
        onModeInit: (context) => {
          if (!isStandaloneLocalViewer()) {
            context?.extensionManager?.setActiveDataSource?.("dicomweb");
          }
          return originalOnModeInit?.(context);
        },
        onModeEnter: (context) => {
          if (!isStandaloneLocalViewer()) {
            context?.servicesManager?.services?.panelService?.activatePanel?.(workspacePanel, true);
          }
          return originalOnModeEnter?.(context);
        },
        routes: baseRoute
          ? [
              {
                ...baseRoute,
                layoutTemplate: () => {
                  const layout = baseRoute.layoutTemplate();
                  const props = layout?.props ?? {};
                  const rightPanels = Array.isArray(props.rightPanels)
                    ? [...props.rightPanels]
                    : [];
                  if (!rightPanels.includes(aiChatPanel)) {
                    rightPanels.push(aiChatPanel);
                  }
                  if (!isStandaloneLocalViewer() && !rightPanels.includes(workspacePanel)) {
                    rightPanels.push(workspacePanel);
                  }

                  return {
                    ...layout,
                    props: {
                      ...props,
                      rightPanels,
                      rightPanelClosed: false,
                      rightPanelResizable: true,
                    },
                  };
                },
              },
            ]
          : baseMode.routes,
      };
    },
  };

  window.__RADSYSX_FHIR_MODE__ = {
    id: "@radsysx/mode-fhir",
    async modeFactory({ modeConfiguration, loadModules }) {
      const [longitudinalMode] = await loadModules(["@ohif/mode-longitudinal"]);
      const baseMode = longitudinalMode.modeFactory({ modeConfiguration });
      const aiChatPanel = "@radsysx/extension-clinical.panelModule.aiChat";
      const baseRoute = baseMode.routes?.[0];
      const originalOnModeInit = baseMode.onModeInit?.bind(baseMode);
      const originalOnModeEnter = baseMode.onModeEnter?.bind(baseMode);

      return {
        ...baseMode,
        id: "@radsysx/mode-fhir",
        routeName: "fhir-viewer",
        displayName: "RadSysX FHIR Viewer",
        onModeInit: (context) => {
          const fhirDataSource = context?.extensionManager?.getDataSources?.("fhir")?.[0];
          if (!fhirDataSource) {
            throw new Error("The FHIR data source is unavailable.");
          }
          context.extensionManager.setActiveDataSource("fhir");
          return originalOnModeInit?.(context);
        },
        onModeEnter: (context) => {
          context?.servicesManager?.services?.panelService?.activatePanel?.(aiChatPanel, true);
          return originalOnModeEnter?.(context);
        },
        isValidMode: () => ({ valid: true }),
        routes: baseRoute
          ? [
              {
                ...baseRoute,
                layoutTemplate: () => {
                  const layout = baseRoute.layoutTemplate();
                  const props = layout?.props ?? {};
                  const rightPanels = Array.isArray(props.rightPanels)
                    ? [...props.rightPanels]
                    : [];
                  if (!rightPanels.includes(aiChatPanel)) {
                    rightPanels.push(aiChatPanel);
                  }

                  return {
                    ...layout,
                    props: {
                      ...props,
                      rightPanels,
                      rightPanelClosed: false,
                      rightPanelResizable: true,
                    },
                  };
                },
              },
            ]
          : baseMode.routes,
      };
    },
  };

  function isStandaloneLocalViewer() {
    return Boolean(window.__RADSYSX_LOCAL_VIEWER__);
  }
})();
