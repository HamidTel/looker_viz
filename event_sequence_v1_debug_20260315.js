looker.plugins.visualizations.add({
  id: "event_sequence_v1_debug_20260315",
  label: "Event Sequence Debug",

  create: function (element) {
    element.innerHTML = "<div id='viz' style='padding:20px;font-family:Arial,sans-serif;color:black;'>create reached</div>";
  },

  updateAsync: function (data, element, config, queryResponse, details, doneRendering) {
    element.innerHTML = `
      <div style="padding:20px;font-family:Arial,sans-serif;color:black;">
        <div><b>updateAsync reached</b></div>
        <div>rows: ${Array.isArray(data) ? data.length : "not-array"}</div>
      </div>
    `;
    doneRendering();
  }
});