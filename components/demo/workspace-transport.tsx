"use client";

import { createContext, useContext } from "react";
import type { WorkspaceRequest } from "@/lib/browser-demo-http";

const workingRequest: WorkspaceRequest = (href, init) => fetch(href, init);

export const DemoRequestContext = createContext<WorkspaceRequest | null>(null);

export function useWorkspaceRequest() {
  return useContext(DemoRequestContext) ?? workingRequest;
}

export function useWorkspaceMode(): "working" | "demo" {
  return useContext(DemoRequestContext) ? "demo" : "working";
}
