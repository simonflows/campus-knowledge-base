"use client";

import { useEffect } from "react";
import { init as initChannel } from "@/lib/bridge/channel";
import { init as initPing } from "@/lib/bridge/ping";
import { init as initErrors } from "@/lib/bridge/errors";
import { init as initInspector } from "@/lib/bridge/inspector";
import { init as initRouter } from "@/lib/bridge/router";
import { InspectorOverlay } from "./inspector-overlay";

export function BridgeProvider({
  trustedOrigin,
  basePath,
}: {
  trustedOrigin: string;
  basePath: string;
}) {
  useEffect(() => {
    const closeChannel = initChannel(trustedOrigin);
    if (!closeChannel) return;

    const cleanups = [
      initPing(),
      initErrors(),
      initInspector(),
      initRouter(basePath),
    ];

    return () => {
      closeChannel();
      cleanups.forEach((fn) => fn());
    };
  }, [basePath, trustedOrigin]);

  return <InspectorOverlay />;
}
