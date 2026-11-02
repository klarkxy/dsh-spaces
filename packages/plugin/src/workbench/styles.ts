/** Self-contained workbench styles. No desktop Tailwind. */

import { UI_TOKENS_CSS } from "../../../../src/shared/ui/tokens";
import { WORKBENCH_BASE_CSS } from "./styles-parts/base";
import { WORKBENCH_FEATURES_CSS } from "./styles-parts/features";
import { WORKBENCH_SHELL_CSS } from "./styles-parts/shell";
import { WORKBENCH_TOKENS_CSS } from "./styles-parts/tokens";

export { UI_TOKENS_CSS };
export {
  WORKBENCH_BASE_CSS,
  WORKBENCH_FEATURES_CSS,
  WORKBENCH_SHELL_CSS,
  WORKBENCH_TOKENS_CSS,
};

/**
 * The composed workbench stylesheet.
 *
 * Order: the shared `--dsh-ui-*` token layer, then the workbench tokens, the
 * base rules, the shell rules and the feature rules. The rules themselves are
 * unchanged; only their grouping moved into `styles-parts/`.
 *
 * The stylesheet lives in `styles-parts/` rather than `styles/` so that
 * `import … from "./styles"` keeps resolving to this file and never to a
 * directory.
 */
export const WORKBENCH_CSS = `${UI_TOKENS_CSS}${WORKBENCH_TOKENS_CSS}${WORKBENCH_BASE_CSS}${WORKBENCH_SHELL_CSS}${WORKBENCH_FEATURES_CSS}
.dsh-wb-dialog.dsh-wb-create-dialog{display:flex;flex-direction:column;overflow:hidden;max-height:calc(100dvh - 48px)}
.dsh-wb-create-dialog>.dsh-wb-title,.dsh-wb-create-dialog>.dsh-wb-actions{flex:none}
.dsh-wb-create-fields{min-height:0;overflow-y:auto;overscroll-behavior:contain;padding:0 4px 8px}
.dsh-wb-create-dialog>.dsh-wb-actions{padding-top:14px}
`;
