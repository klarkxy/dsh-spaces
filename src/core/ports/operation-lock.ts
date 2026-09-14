export interface OperationLock {
  run<T>(label: string, action: () => Promise<T>): Promise<T>;
}
