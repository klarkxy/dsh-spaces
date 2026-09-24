import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import { IconPicker } from "../../../packages/plugin/src/workbench/components.tsx";
import { WORKBENCH_CSS } from "../../../packages/plugin/src/workbench/styles.ts";

function Harness(): React.ReactElement {
  const [length, setLength] = useState(0);
  const [blocked, setBlocked] = useState(false);
  return (
    <>
      <style>{WORKBENCH_CSS}</style>
      <IconPicker
        locale="zh"
        onChange={(icon) => setLength(icon.length)}
        onState={(state) => setBlocked(state !== "idle")}
      />
      <button type="button" id="create" disabled={blocked}>创建</button>
      <output id="length">{length}</output>
    </>
  );
}

const root = document.getElementById("root");
if (!root) throw new Error("missing root");
createRoot(root).render(<Harness />);
