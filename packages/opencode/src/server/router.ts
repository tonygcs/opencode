import type { MiddlewareHandler } from "hono"
import type { UpgradeWebSocket } from "hono/ws"
import { getAdaptor } from "@/control-plane/adaptors"
import { WorkspaceID } from "@/control-plane/schema"
import { Workspace } from "@/control-plane/workspace"
import { ServerProxy } from "./proxy"
import { lazy } from "@/util/lazy"
import { Filesystem } from "@/util/filesystem"
import { Instance } from "@/project/instance"
import { InstanceBootstrap } from "@/project/bootstrap"
import { InstanceRoutes } from "./instance"
import { Server } from "./server"

type Rule = { method?: string; path: string; exact?: boolean; action: "local" | "forward" }

const RULES: Array<Rule> = [
  { path: "/session/status", action: "forward" },
  { method: "GET", path: "/session", action: "local" },
]

function local(method: string, path: string) {
  for (const rule of RULES) {
    if (rule.method && rule.method !== method) continue
    const match = rule.exact ? path === rule.path : path === rule.path || path.startsWith(rule.path + "/")
    if (match) return rule.action === "local"
  }
  return false
}

export function WorkspaceRouterMiddleware(upgrade: UpgradeWebSocket): MiddlewareHandler {
  const routes = lazy(() => InstanceRoutes(upgrade))

  return async (c) => {
    const raw = c.req.query("directory") || c.req.header("x-opencode-directory") || process.cwd()
    const directory = Filesystem.resolve(
      (() => {
        try {
          return decodeURIComponent(raw)
        } catch {
          return raw
        }
      })(),
    )

    // c.req.path always returns the full path in Hono (even inside sub-apps
    // mounted via .route()). Strip the basePath from the URL so InstanceRoutes
    // can match its own routes (e.g. /provider, /path, /project).
    const basePath = Server.basePath()
    const rawUrl = new URL(c.req.raw.url)
    if (basePath && rawUrl.pathname.startsWith(basePath)) {
      rawUrl.pathname = rawUrl.pathname.slice(basePath.length) || "/"
    }
    const strippedRequest = new Request(rawUrl.toString(), c.req.raw)

    const url = new URL(c.req.url)
    const workspaceParam = url.searchParams.get("workspace") || c.req.header("x-opencode-workspace")

    // TODO: If session is being routed, force it to lookup the
    // project/workspace

    // If no workspace is provided we use the "project" workspace
    if (!workspaceParam) {
      return Instance.provide({
        directory,
        init: InstanceBootstrap,
        async fn() {
          return routes().fetch(strippedRequest, c.env)
        },
      })
    }

    const workspaceID = WorkspaceID.make(workspaceParam)
    const workspace = await Workspace.get(workspaceID)
    if (!workspace) {
      return new Response(`Workspace not found: ${workspaceID}`, {
        status: 500,
        headers: {
          "content-type": "text/plain; charset=utf-8",
        },
      })
    }

    const adaptor = await getAdaptor(workspace.type)
    const target = await adaptor.target(workspace)

    if (target.type === "local") {
      return Instance.provide({
        directory: target.directory,
        init: InstanceBootstrap,
        async fn() {
          return routes().fetch(strippedRequest, c.env)
        },
      })
    }

    if (local(c.req.method, url.pathname)) {
      // No instance provided because we are serving cached data; there
      // is no instance to work with
      return routes().fetch(strippedRequest, c.env)
    }

    if (c.req.header("upgrade")?.toLowerCase() === "websocket") {
      return ServerProxy.websocket(upgrade, target, c.req.raw, c.env)
    }

    const headers = new Headers(c.req.raw.headers)
    headers.delete("x-opencode-workspace")

    return ServerProxy.http(
      target,
      new Request(c.req.raw, {
        headers,
      }),
    )
  }
}
