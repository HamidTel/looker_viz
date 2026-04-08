looker.plugins.visualizations.add({
  id: "event_sequence_v1",
  label: "Event Sequence V1.0",

  options: {
    lane_order: {
      type: "string",
      label: "Lane Order",
      section: "Layout",
      order: 1,
      display: "text",
      default: "UE1,P-CSCF,GNB,AMF,MME,SGW,UE2"
    },
    lane_spacing: {
      type: "number",
      label: "Lane Spacing",
      section: "Layout",
      order: 2,
      default: 150
    },
    row_spacing: {
      type: "number",
      label: "Row Spacing",
      section: "Layout",
      order: 3,
      default: 70
    },
    show_tooltips: {
      type: "boolean",
      label: "Show Tooltips",
      section: "Layout",
      order: 4,
      default: true
    }
  },

  create: function (element) {
    element.innerHTML = `
      <style>
        html, body {
          margin: 0;
          padding: 0;
        }
        .network-sequence-trace-root {
          width: 100%;
          height: 100%;
          min-height: 500px;
          overflow: auto;
          background: #ffffff;
          font-family: Arial, sans-serif;
        }
      </style>
      <div id="viz" class="network-sequence-trace-root"></div>
    `;
  },

  updateAsync: function (data, element, config, queryResponse, details, doneRendering) {
    const container = getOrCreateContainer(element);

    try {
      renderLookerViz(data, element, config || {}, queryResponse);
      doneRendering();
    } catch (err) {
      container.innerHTML = `
  <div style="padding:20px;font-family:Arial,sans-serif;color:#b00020;line-height:1.5;white-space:pre-wrap;">
    <div style="font-weight:700;font-size:16px;margin-bottom:10px;">Visualization Error</div>
    <div style="font-size":13px;">${err && err.message ? err.message : String(err)}</div>
  </div>
`;
      console.error(err);
      doneRendering();
    }
  }
});

const SVG_NS = "http://www.w3.org/2000/svg";

const DEFAULT_STYLE = {
  laneSpacing: 150,
  rowSpacing: 70,
  showTooltips: true
};

const REQUIRED_SEQUENCE_TEXT =
  "Expected field order:\n" +
  "1. call_flow_label\n" +
  "2. event_name\n" +
  "3. start_ts (or start_ts_time / start ts time)\n" +
  "4. rat_name\n" +
  "5. cell_id\n" +
  "6. source_node\n" +
  "7. destination_node\n" +
  "8. remarks\n" +
  "9. calling_final_call_label\n" +
  "10. called_final_call_label\n" +
  "11. time_since_invite (optional for elapsed display)\n" +
  "12. tooltip field immediately after called_final_call_label";

function parseLaneOrderConfig(value) {
  if (!value) {
    return ["UE1", "P-CSCF", "GNB", "AMF", "MME", "SGW", "UE2"];
  }

  return String(value)
    .split(",")
    .map(v => v.trim())
    .filter(Boolean)
    .map(v => v.toUpperCase());
}

function getLayoutConfig(config) {
  const laneSpacing = Number(config.lane_spacing);
  const rowSpacing = Number(config.row_spacing);

  return {
    laneOrder: parseLaneOrderConfig(config.lane_order),
    laneSpacing: Number.isFinite(laneSpacing) ? laneSpacing : DEFAULT_STYLE.laneSpacing,
    rowSpacing: Number.isFinite(rowSpacing) ? rowSpacing : DEFAULT_STYLE.rowSpacing,
    showTooltips: config.show_tooltips !== false
  };
}

function parseTimestamp(value) {
  if (!value) return null;

  const direct = new Date(value);
  if (!isNaN(direct.getTime())) return direct;

  const normalized = String(value).replace(" ", "T");
  const fallback = new Date(normalized);
  if (!isNaN(fallback.getTime())) return fallback;

  return null;
}

function formatFullTimestamp(value) {
  const d = parseTimestamp(value);
  if (!d) return value || "";

  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun",
                  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

  const month = months[d.getMonth()];
  const day = d.getDate();
  const year = d.getFullYear();

  let hours = d.getHours();
  const minutes = String(d.getMinutes()).padStart(2, "0");
  const seconds = String(d.getSeconds()).padStart(2, "0");
  const ampm = hours >= 12 ? "PM" : "AM";

  hours = hours % 12;
  if (hours === 0) hours = 12;

  return `${month} ${day}, ${year}, ${hours}:${minutes}:${seconds} ${ampm}`;
}

function formatElapsed(seconds) {
  if (seconds == null || seconds === "") return "";

  const numeric = Number(seconds);
  if (!Number.isFinite(numeric) || numeric < 0) return "";

  const rounded = Math.round(numeric);

  if (rounded <= 1) return "+1 sec";
  if (rounded < 60) return `+${rounded} sec`;

  const mins = Math.floor(rounded / 60);
  const secs = rounded % 60;

  if (secs === 0) {
    return mins === 1 ? "+1 min" : `+${mins} min`;
  }

  return `+${mins}m ${secs}s`;
}

function escapeText(v) {
  return v == null ? "" : String(v);
}

function normalizeNode(v) {
  if (!v) return "";
  return String(v).trim().toUpperCase();
}

function hasRealRemark(v) {
  if (v == null) return false;
  const s = String(v).trim();
  if (s === "") return false;
  if (s.toLowerCase() === "null") return false;
  return true;
}

function getEventArrowColors(row) {
  const name = String(row.event_name || "").toLowerCase();

  if (name.includes("calling")) {
    return {
      stroke: "#2b6cb0",
      fill: "#2b6cb0"
    };
  }

  if (name.includes("called")) {
    return {
      stroke: "#2f855a",
      fill: "#2f855a"
    };
  }

  return {
    stroke: "#333",
    fill: "#333"
  };
}

function getEventSortPriority(eventName) {
  const name = String(eventName || "").trim().toLowerCase();

  const order = [
    "calling invite",
    "called invite",
    "calling ngap modify - epsfb",
    "calling create first bearer",
    "calling create bearer failed first",
    "calling create bearer last",
    "calling create bearer failed last",
    "calling asr",
    "called asr",
    "calling bye",
    "called bye"
  ];

  const idx = order.indexOf(name);
  return idx >= 0 ? idx : 999;
}

function getEventPresence(rows) {
  let hasCalling = false;
  let hasCalled = false;

  rows.forEach(row => {
    const name = String(row.event_name || "").toLowerCase();
    if (name.includes("calling")) hasCalling = true;
    if (name.includes("called")) hasCalled = true;
  });

  return { hasCalling, hasCalled };
}

function createSvgEl(name, attrs = {}) {
  const el = document.createElementNS(SVG_NS, name);
  Object.entries(attrs).forEach(([k, v]) => el.setAttribute(k, v));
  return el;
}

function clearElement(el) {
  while (el.firstChild) el.removeChild(el.firstChild);
}

function getOrCreateContainer(element) {
  let container = element.querySelector("#viz");

  if (!container) {
    element.innerHTML = `
      <div id="viz"
           class="network-sequence-trace-root"
           style="width:100%;height:100%;min-height:500px;overflow:auto;background:#ffffff;font-family:Arial,sans-serif;">
      </div>
    `;
    container = element.querySelector("#viz");
  }

  return container;
}

function cellToString(cell) {
  if (cell == null) return "";
  if (typeof cell !== "object") return String(cell);
  if (cell.rendered != null && cell.rendered !== "") return String(cell.rendered);
  if (cell.value != null && cell.value !== "") return String(cell.value);
  return "";
}

function leafFieldName(name) {
  if (!name) return "";
  const parts = String(name).split(".");
  return parts[parts.length - 1];
}

function normalizeFieldToken(name) {
  return leafFieldName(name).toLowerCase().replace(/[^a-z0-9]/g, "");
}

function fieldMatches(actualFieldName, aliases, allowTimeSuffix) {
  const actual = normalizeFieldToken(actualFieldName);

  return aliases.some(alias => {
    const base = normalizeFieldToken(alias);
    if (actual === base) return true;
    if (allowTimeSuffix && actual === `${base}time`) return true;
    return false;
  });
}

function getOrderedFieldNames(queryResponse) {
  const dims = (queryResponse.fields && queryResponse.fields.dimension_like) || [];
  const measures = (queryResponse.fields && queryResponse.fields.measure_like) || [];
  return [...dims, ...measures].map(f => f.name);
}

function findMatchingFieldName(queryResponse, aliases, allowTimeSuffix = false) {
  const ordered = getOrderedFieldNames(queryResponse);
  return ordered.find(name => fieldMatches(name, aliases, allowTimeSuffix)) || null;
}

function resolveFieldMap(queryResponse) {
  const requiredDefs = [
    { key: "call_flow_label", aliases: ["call_flow_label"], allowTimeSuffix: false },
    { key: "event_name", aliases: ["event_name"], allowTimeSuffix: false },
    { key: "start_ts_raw", aliases: ["start_ts"], allowTimeSuffix: true },
    { key: "rat_name", aliases: ["rat_name"], allowTimeSuffix: false },
    { key: "cell_id", aliases: ["cell_id"], allowTimeSuffix: false },
    { key: "source_node", aliases: ["source_node"], allowTimeSuffix: false },
    { key: "destination_node", aliases: ["destination_node"], allowTimeSuffix: false },
    { key: "remarks", aliases: ["remarks", "remarks_styled"], allowTimeSuffix: false },
    { key: "calling_final_call_label", aliases: ["calling_final_call_label"], allowTimeSuffix: false },
    { key: "called_final_call_label", aliases: ["called_final_call_label"], allowTimeSuffix: false }
  ];

  const fieldMap = {};
  const unmatched = [];

  requiredDefs.forEach(def => {
    const matched = findMatchingFieldName(queryResponse, def.aliases, def.allowTimeSuffix);
    if (!matched) {
      unmatched.push(def.aliases[0]);
    } else {
      fieldMap[def.key] = matched;
    }
  });

  if (unmatched.length) {
    throw new Error(
      `Unmatched required field(s): ${unmatched.join(", ")}.\n${REQUIRED_SEQUENCE_TEXT}`
    );
  }

  // optional field for elapsed display
  const timeSinceInviteField = findMatchingFieldName(queryResponse, ["time_since_invite"], false);
  fieldMap.time_since_invite = timeSinceInviteField || null;

  const ordered = getOrderedFieldNames(queryResponse);
  const calledIdx = ordered.findIndex(name => name === fieldMap.called_final_call_label);

  if (calledIdx < 0 || calledIdx + 1 >= ordered.length) {
    throw new Error(
      `Unmatched tooltip field: no field found immediately after called_final_call_label.\n${REQUIRED_SEQUENCE_TEXT}`
    );
  }

  fieldMap.tooltip = ordered[calledIdx + 1];

  return fieldMap;
}

function buildLaneNames(nodeSet, configuredOrder) {
  const laneNames = configuredOrder.filter(name => nodeSet.has(name));
  Array.from(nodeSet).forEach(name => {
    if (!laneNames.includes(name)) laneNames.push(name);
  });
  return laneNames;
}

function getLookerRows(data, config, queryResponse) {
  const fieldMap = resolveFieldMap(queryResponse);

  const rows = data.map(r => ({
    call_flow_label: escapeText(cellToString(r[fieldMap.call_flow_label])),
    event_name: escapeText(cellToString(r[fieldMap.event_name])),
    start_ts_raw: escapeText(cellToString(r[fieldMap.start_ts_raw])),
    rat_name: escapeText(cellToString(r[fieldMap.rat_name])),
    cell_id: escapeText(cellToString(r[fieldMap.cell_id])),
    source_node: normalizeNode(cellToString(r[fieldMap.source_node])),
    destination_node: normalizeNode(cellToString(r[fieldMap.destination_node])),
    remarks: escapeText(cellToString(r[fieldMap.remarks])),
    calling_final_call_label: escapeText(cellToString(r[fieldMap.calling_final_call_label])),
    called_final_call_label: escapeText(cellToString(r[fieldMap.called_final_call_label])),
    tooltip: escapeText(cellToString(r[fieldMap.tooltip])),
    time_since_invite: fieldMap.time_since_invite ? escapeText(cellToString(r[fieldMap.time_since_invite])) : ""
  }));

  if (!rows.length) {
    throw new Error(`No rows were built from Looker data.\n${REQUIRED_SEQUENCE_TEXT}`);
  }

  const nodeSet = new Set();
  rows.forEach(r => {
    if (r.source_node) nodeSet.add(r.source_node);
    if (r.destination_node) nodeSet.add(r.destination_node);
  });

  const layout = getLayoutConfig(config || {});
  const laneNames = buildLaneNames(nodeSet, layout.laneOrder);

  if (!laneNames.length) {
    throw new Error(`No lane names could be derived from source_node / destination_node.\n${REQUIRED_SEQUENCE_TEXT}`);
  }

  const laneIndex = {};
  laneNames.forEach((name, idx) => {
    laneIndex[name] = idx;
  });

  const enriched = rows.map(r => ({
    ...r,
    start_ts: parseTimestamp(r.start_ts_raw),
    from: laneIndex[r.source_node] != null ? Number(laneIndex[r.source_node]) : null,
    to: laneIndex[r.destination_node] != null ? Number(laneIndex[r.destination_node]) : null,
    elapsedLabel: formatElapsed(r.time_since_invite)
  }));

  enriched.sort((a, b) => {
    if (a.start_ts && b.start_ts) {
      const timeDiff = a.start_ts - b.start_ts;
      if (timeDiff !== 0) return timeDiff;

      const priorityDiff = getEventSortPriority(a.event_name) - getEventSortPriority(b.event_name);
      if (priorityDiff !== 0) return priorityDiff;

      return a.event_name.localeCompare(b.event_name);
    }

    if (a.start_ts && !b.start_ts) return -1;
    if (!a.start_ts && b.start_ts) return 1;

    const priorityDiff = getEventSortPriority(a.event_name) - getEventSortPriority(b.event_name);
    if (priorityDiff !== 0) return priorityDiff;

    return a.event_name.localeCompare(b.event_name);
  });

  enriched.forEach((r, idx) => {
    r.rowIndex = idx;
  });

  return {
    rows: enriched,
    laneNames
  };
}

function addTitle(svg, callFlowLabel, callingLabel, calledLabel, eventPresence) {
  const title = createSvgEl("text", {
    x: 20,
    y: 28,
    "font-size": 20,
    "font-weight": "700",
    fill: "#000"
  });
  title.textContent = callFlowLabel ? `Event Sequence V1.0 | ${callFlowLabel}` : "Event Sequence V1.0";
  svg.appendChild(title);

  const authorText = createSvgEl("text", {
    x: 20,
    y: 40,
    "font-size": 10,
    fill: "#000"
  });
  authorText.textContent = "by HB";
  svg.appendChild(authorText);

  const onlyCalled = eventPresence.hasCalled && !eventPresence.hasCalling;
  const onlyCalling = eventPresence.hasCalling && !eventPresence.hasCalled;

  const callingBoxFill = onlyCalled ? "#eeeeee" : "#dceeff";
  const callingBoxStroke = onlyCalled ? "#cccccc" : "#9fc5e8";
  const calledBoxFill = onlyCalling ? "#eeeeee" : "#e9f7df";
  const calledBoxStroke = onlyCalling ? "#cccccc" : "#b6d7a8";

  const badge1 = createSvgEl("rect", {
    x: 20,
    y: 52,
    rx: 4,
    ry: 4,
    width: 170,
    height: 24,
    fill: callingBoxFill,
    stroke: callingBoxStroke
  });
  svg.appendChild(badge1);

  const badge1Text = createSvgEl("text", {
    x: 30,
    y: 68,
    "font-size": 12,
    fill: "#000"
  });
  badge1Text.textContent = `Calling: ${callingLabel || "-"}`;
  svg.appendChild(badge1Text);

  const badge2 = createSvgEl("rect", {
    x: 205,
    y: 52,
    rx: 4,
    ry: 4,
    width: 170,
    height: 24,
    fill: calledBoxFill,
    stroke: calledBoxStroke
  });
  svg.appendChild(badge2);

  const badge2Text = createSvgEl("text", {
    x: 215,
    y: 68,
    "font-size": 12,
    fill: "#000"
  });
  badge2Text.textContent = `Called: ${calledLabel || "-"}`;
  svg.appendChild(badge2Text);
}

function drawLanes(svg, laneNames, laneX, topY, bottomY) {
  laneNames.forEach((name, idx) => {
    const x = laneX[idx];

    const line = createSvgEl("line", {
      x1: x,
      y1: topY,
      x2: x,
      y2: bottomY,
      stroke: "#b7b7b7",
      "stroke-width": 1,
      "stroke-dasharray": "4,4"
    });
    svg.appendChild(line);

    const topBox = createSvgEl("rect", {
      x: x - 45,
      y: topY - 34,
      width: 90,
      height: 24,
      rx: 5,
      ry: 5,
      fill: "#f5f5f5",
      stroke: "#d0d0d0"
    });
    svg.appendChild(topBox);

    const topText = createSvgEl("text", {
      x: x,
      y: topY - 18,
      "text-anchor": "middle",
      "font-size": 12,
      "font-weight": "600",
      fill: "#000"
    });
    topText.textContent = name;
    svg.appendChild(topText);

    const bottomBox = createSvgEl("rect", {
      x: x - 45,
      y: bottomY + 10,
      width: 90,
      height: 24,
      rx: 5,
      ry: 5,
      fill: "#f5f5f5",
      stroke: "#d0d0d0"
    });
    svg.appendChild(bottomBox);

    const bottomText = createSvgEl("text", {
      x: x,
      y: bottomY + 26,
      "text-anchor": "middle",
      "font-size": 12,
      "font-weight": "600",
      fill: "#000"
    });
    bottomText.textContent = name;
    svg.appendChild(bottomText);
  });
}

function addTooltip(el, text, enabled) {
  if (!enabled || !text) return;
  const title = createSvgEl("title");
  title.textContent = String(text);
  el.appendChild(title);
}

function drawSameLaneEvent(svg, row, x, y, showTooltips) {
  const g = createSvgEl("g");
  const colors = getEventArrowColors(row);

  const tsText = createSvgEl("text", {
    x: 20,
    y: y + 4,
    "font-size": 9,
    fill: "#000"
  });
  tsText.textContent = formatFullTimestamp(row.start_ts_raw);
  g.appendChild(tsText);

  const path = createSvgEl("path", {
    d: `M ${x} ${y}
        C ${x + 34} ${y}, ${x + 34} ${y + 28}, ${x} ${y + 28}
        C ${x - 18} ${y + 28}, ${x - 18} ${y + 8}, ${x} ${y + 8}`,
    fill: "none",
    stroke: colors.stroke,
    "stroke-width": 2
  });
  g.appendChild(path);

  const arrowHead = createSvgEl("polygon", {
    points: `${x},${y + 8} ${x - 8},${y + 4} ${x - 8},${y + 12}`,
    fill: colors.fill
  });
  g.appendChild(arrowHead);

  const eventText = createSvgEl("text", {
    x: x + 40,
    y: y + 12,
    "font-size": 10,
    "font-weight": "600",
    fill: "#000"
  });
  eventText.textContent = row.event_name || "";
  g.appendChild(eventText);

  const metaText = createSvgEl("text", {
    x: x + 40,
    y: y + 28,
    "font-size": 9,
    fill: "#000"
  });
  metaText.textContent = [row.rat_name, row.cell_id].filter(Boolean).join(" | ");
  g.appendChild(metaText);

  if (hasRealRemark(row.remarks)) {
    const remarkText = createSvgEl("text", {
      x: x + 40,
      y: y + 42,
      "font-size": 9,
      fill: "red"
    });
    remarkText.textContent = row.remarks;
    g.appendChild(remarkText);
  }

  if (row.elapsedLabel) {
    const elapsed = createSvgEl("text", {
      x: x - 14,
      y: y + 18,
      "font-size": 9,
      fill: "#000",
      "text-anchor": "end"
    });
    elapsed.textContent = row.elapsedLabel;
    g.appendChild(elapsed);
  }

  addTooltip(g, row.tooltip || row.event_name, showTooltips);
  svg.appendChild(g);
}

function drawCrossLaneEvent(svg, row, x1, x2, y, showTooltips) {
  const g = createSvgEl("g");
  const colors = getEventArrowColors(row);

  const tsText = createSvgEl("text", {
    x: 20,
    y: y + 4,
    "font-size": 9,
    fill: "#000"
  });
  tsText.textContent = formatFullTimestamp(row.start_ts_raw);
  g.appendChild(tsText);

  const line = createSvgEl("line", {
    x1: x1,
    y1: y,
    x2: x2,
    y2: y,
    stroke: colors.stroke,
    "stroke-width": 2
  });
  g.appendChild(line);

  const dir = x2 >= x1 ? 1 : -1;
  const arrowHead = createSvgEl("polygon", {
    points: `${x2},${y} ${x2 - 10 * dir},${y - 5} ${x2 - 10 * dir},${y + 5}`,
    fill: colors.fill
  });
  g.appendChild(arrowHead);

  const left = Math.min(x1, x2);

  const eventText = createSvgEl("text", {
    x: left + 8,
    y: y - 12,
    "font-size": 10,
    "font-weight": "600",
    fill: "#000"
  });
  eventText.textContent = row.event_name || "";
  g.appendChild(eventText);

  const metaText = createSvgEl("text", {
    x: left + 8,
    y: y + 15,
    "font-size": 9,
    fill: "#000"
  });
  metaText.textContent = [row.rat_name, row.cell_id].filter(Boolean).join(" | ");
  g.appendChild(metaText);

  if (hasRealRemark(row.remarks)) {
    const remarkText = createSvgEl("text", {
      x: left + 8,
      y: y + 30,
      "font-size": 9,
      fill: "red"
    });
    remarkText.textContent = row.remarks;
    g.appendChild(remarkText);
  }

  if (row.elapsedLabel) {
    const elapsed = createSvgEl("text", {
      x: (x1 + x2) / 2,
      y: y - 26,
      "font-size": 9,
      fill: "#000",
      "text-anchor": "middle"
    });
    elapsed.textContent = row.elapsedLabel;
    g.appendChild(elapsed);
  }

  addTooltip(g, row.tooltip || row.event_name, showTooltips);
  svg.appendChild(g);
}

function renderLookerViz(data, element, config, queryResponse) {
  const container = getOrCreateContainer(element);
  clearElement(container);

  if (!data || !Array.isArray(data)) {
    container.innerHTML = "<div style='padding:16px;font-family:Arial,sans-serif;color:#b00020;'>No Looker data array received.</div>";
    return;
  }

  if (!queryResponse || !queryResponse.fields) {
    container.innerHTML = "<div style='padding:16px;font-family:Arial,sans-serif;color:#b00020;'>No queryResponse.fields received.</div>";
    return;
  }

  const layout = getLayoutConfig(config || {});
  const parsed = getLookerRows(data, config || {}, queryResponse);
  const rows = parsed.rows;
  const laneNames = parsed.laneNames;

  if (!rows.length) {
    container.innerHTML = "<div style='padding:16px;font-family:Arial,sans-serif;color:#b00020;'>Rows were received from Looker, but none were parsed successfully.</div>";
    return;
  }

  if (!laneNames.length) {
    container.innerHTML = "<div style='padding:16px;font-family:Arial,sans-serif;color:#b00020;'>Rows were parsed, but no lane names were found.</div>";
    return;
  }

  const callFlowLabel = rows[0].call_flow_label || "";
  const callingLabel = rows[0].calling_final_call_label || "";
  const calledLabel = rows[0].called_final_call_label || "";
  const eventPresence = getEventPresence(rows);

  const leftPad = 120;
  const rightPad = 120;
  const topPad = 120;
  const laneTopY = topPad;
  const firstRowY = laneTopY + 45;
  const chartWidth = leftPad + rightPad + (laneNames.length * layout.laneSpacing * 0.8) + 200;
  const chartHeight = firstRowY + (rows.length * layout.rowSpacing * 0.7) + 100;
  const bottomY = firstRowY + (rows.length - 1) * layout.rowSpacing * 0.7 + 30;
  const scale = 1.03;

  const svg = createSvgEl("svg", {
    width: chartWidth * scale,
    height: chartHeight * scale,
    viewBox: `0 0 ${chartWidth} ${chartHeight}`,
    preserveAspectRatio: "xMinYMin meet",
    style: "font-family: Arial, sans-serif; background: white; display: block;"
  });

  addTitle(svg, callFlowLabel, callingLabel, calledLabel, eventPresence);

  const laneX = laneNames.map((name, idx) =>
    leftPad + idx * (layout.laneSpacing * 0.8) + 80
  );

  drawLanes(svg, laneNames, laneX, laneTopY, bottomY);

  rows.forEach((row, idx) => {
    if (row.from == null || row.to == null) return;

    const y = firstRowY + idx * (layout.rowSpacing * 0.7);
    const x1 = laneX[Number(row.from)];
    const x2 = laneX[Number(row.to)];

    if (row.from === row.to) {
      drawSameLaneEvent(svg, row, x1, y, layout.showTooltips);
    } else {
      drawCrossLaneEvent(svg, row, x1, x2, y, layout.showTooltips);
    }
  });

  container.appendChild(svg);
}