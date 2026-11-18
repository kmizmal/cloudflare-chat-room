import { escapeXml } from "./validation";
import type { MessageRecord } from "./types";

type SvgParams = {
  width: number;
  height: number;
  limit: number;
  theme: string;
  title: string;
  fontSize: number;
};

export function parseSvgParams(params: URLSearchParams): SvgParams {
  const num = (key: string, fallback: number, max: number) => {
    const n = Math.abs(Number(params.get(key)) || fallback);
    return Math.min(max, Math.floor(n));
  };
  return {
    width: num("width", 500, 2000),
    height: num("height", 300, 2000),
    limit: num("limit", 20, 100),
    theme: params.get("theme") === "light" ? "light" : "",
    title: (params.get("title") || "").slice(0, 200),
    fontSize: num("fontSize", 12, 72) || 12,
  };
}

export function record2svg(records: MessageRecord[], p: SvgParams, roomId: string): string {
  const rows = records
    .slice()
    .reverse()
    .map((m) => {
      // SVG is generated server-side and cached as an image, so fix the zone
      // (the reference hard-codes UTC+8 with moment().add(8, 'hours')).
      // The HTML page formats in the viewer's own zone instead.
      const date = new Intl.DateTimeFormat("zh-CN", {
        year: "numeric", month: "2-digit", day: "2-digit",
        hour: "2-digit", minute: "2-digit", hour12: false,
        timeZone: "Asia/Shanghai",
      }).format(new Date(m.ts * 1000));
      const color = escapeXml(m.namecolor);
      const msgcolor = escapeXml(m.msgcolor);
      return `<div class="message"><span class="nickname"><span class="name" style="color:${color}">${escapeXml(m.name)}</span>::<span class="uid">${escapeXml(m.uid)}</span>::<span class="time">${escapeXml(date)}</span>:</span><span class="msg" style="color:${msgcolor}">${escapeXml(m.text)}</span></div>`;
    })
    .join("\n");

  const title = escapeXml(p.title || `${roomId}::record - Chat Room`);

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg width="${p.width}" height="${p.height}" version="1.1" xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink">
  <title>${title}</title>
  <foreignObject width="${p.width}" height="${p.height}">
    <body xmlns="http://www.w3.org/1999/xhtml">
      <style>
        body { margin:0; padding:0; font-family: "Helvetica Neue","PingFang SC",sans-serif; }
        .container { position:absolute; bottom:0; font-size:${p.fontSize}px; width:100%; }
        .container.light { height:100%; background:#fbfbfb; border:1px solid #d4d4d4; box-sizing:border-box; padding-top:30px; overflow:hidden; }
        .container.light::before { content:""; position:absolute; background:#fbfbfb; width:100%; height:26px; top:0; left:0; z-index:2; }
        .container.light::after { content:""; position:absolute; border-radius:50%; background:#fc625d; width:12px; height:12px; left:10px; margin-top:-24px; box-shadow:20px 0 #fdbc40,40px 0 #35cd4b; z-index:2; }
        .content { position:absolute; bottom:0; padding:6px 8px; }
        .container.light .content::before { content:'${title.replace(/'/g, "&apos;")}'; position:fixed; top:0; left:0; height:26px; line-height:26px; font-size:12px; font-weight:700; text-align:center; width:100%; z-index:2; box-sizing:border-box; }
        .nickname { padding-right:5px; color:brown; font-family:Consolas,Monaco,monospace; white-space:nowrap; }
        .name { font-weight:bold; } .uid { color:#cc1105; font-weight:bold; } .time { color:#6f6f6f; }
        .msg { word-break:break-all; }
      </style>
      <div class="container${p.theme === "light" ? " light" : ""}">
        <div class="content">${rows}</div>
      </div>
    </body>
  </foreignObject>
</svg>`;
}
