import { AsyncLocalStorage } from "node:async_hooks";
import type { DiagnosticLogInput, DiagnosticLogLevel } from "../../../shared/diagnostic-log";
import { withDiagnosticCorrelation, type DiagnosticLogger } from "./rotating-log";

type OperationScope = { operation: string; operationId: string };
const operationScope = new AsyncLocalStorage<OperationScope>();
const operationLogger = new AsyncLocalStorage<DiagnosticLogger>();
let sequence = 0;

export function nextDiagnosticOperationId(prefix: string): string {
  return `${prefix}-${process.pid}-${++sequence}`;
}

export function operationDetails(scope?: OperationScope): DiagnosticLogInput["context"] {
  return scope ? { operation: scope.operation, operationId: scope.operationId } : undefined;
}

export function currentOperationDetails(): DiagnosticLogInput["context"] {
  return operationDetails(operationScope.getStore());
}

export function currentDiagnosticLogger(): DiagnosticLogger | undefined {
  return operationLogger.getStore();
}

export function diagnosticOperation<T>(
  logger: DiagnosticLogger,
  operation: string,
  details: DiagnosticLogInput["context"],
  action: () => T,
  operationId = nextDiagnosticOperationId("op"),
): T {
  const scope = { operation, operationId };
  return operationLogger.run(withCorrelation(logger), () => operationScope.run(scope, () => {
    logger.debug("operation.started", "Operation started.", { ...details, ...operationDetails(scope) });
    try {
      return action();
    } catch (error) {
      logger.error("operation.failed", "Operation failed synchronously.", error, { ...details, ...operationDetails(scope) });
      throw error;
    }
  }));
}

export function diagnosticNested<T>(logger: DiagnosticLogger, action: () => T): T {
  return operationLogger.run(logger, action);
}

export function diagnosticCorrelation<T>(requestId: string, action: () => T): T {
  const scope = { operation: "http", operationId: requestId };
  const logger = operationLogger.getStore();
  return operationScope.run(scope, () => logger
    ? operationLogger.run(withDiagnosticCorrelation(logger, operationDetails(scope)), action)
    : action());
}

function withCorrelation(logger: DiagnosticLogger): DiagnosticLogger {
  const scope = operationScope.getStore();
  return scope ? withDiagnosticCorrelation(logger, operationDetails(scope)) : logger;
}

export async function diagnosticStep<T>(
  logger: DiagnosticLogger,
  operation: string,
  details: DiagnosticLogInput["context"],
  action: () => Promise<T>,
  level: DiagnosticLogLevel = "info",
): Promise<T> {
  const context = { ...details, ...currentOperationDetails() };
  const started = Date.now();
  const correlated = withCorrelation(logger);
  correlated.debug("step.started", "Operation step started.", { ...context, step: operation });
  try {
    const result = await action();
    correlated.write({ level, event: "step.completed", message: "Operation step completed.", context: { ...context, step: operation, durationMs: Date.now() - started } });
    return result;
  } catch (error) {
    logger.error("step.failed", "Operation step failed.", error, { ...context, step: operation, durationMs: Date.now() - started });
    throw error;
  }
}

export function diagnosticSyncStep<T>(
  logger: DiagnosticLogger,
  operation: string,
  details: DiagnosticLogInput["context"],
  action: () => T,
): T {
  const context = { ...details, ...currentOperationDetails(), step: operation };
  logger.debug("step.started", "Operation step started.", context);
  try {
    return action();
  } catch (error) {
    logger.error("step.failed", "Operation step failed.", error, context);
    throw error;
  }
}
