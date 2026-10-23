import { BLUEPRINT_FORBIDDEN_SETTINGS, BLUEPRINT_HOST_PACKAGES, BLUEPRINT_MANAGED_ENTRY_IDS, BLUEPRINT_SPACES_CONTROL_PACKAGES } from "../../../../shared/blueprint";

export const HOST_PACKAGE_SET = new Set<string>(BLUEPRINT_HOST_PACKAGES);

export const CONTROL_PACKAGE_SET = new Set<string>(BLUEPRINT_SPACES_CONTROL_PACKAGES);

export const MANAGED_ENTRY_SET = new Set<string>(BLUEPRINT_MANAGED_ENTRY_IDS);

export const FORBIDDEN_SETTINGS = new Set<string>(BLUEPRINT_FORBIDDEN_SETTINGS);

export const LIFECYCLE_SCRIPTS = ["preinstall", "install", "postinstall", "prepare"] as const;

export const JS_TAG = "tag:yaml.org,2002:js";

export const CREDENTIAL_KEY_RE = /(?:^|[_-])(?:api[_-]?key|password|secret|token|cookie|authorization|credential|private[_-]?key)(?:$|[_-])/i;

export const GITHUB_APPLY_MESSAGE = "This version cannot apply blueprints with GitHub sources.";

export const INSPECT_RUNTIME_FAILED = "The bound runtime could not be inspected.";
