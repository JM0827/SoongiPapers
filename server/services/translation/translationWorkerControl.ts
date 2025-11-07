let workersInitialized = false;

export function registerTranslationWorkers(initializer: () => void): void {
  if (workersInitialized) {
    return;
  }
  initializer();
  workersInitialized = true;
}

export function resetTranslationWorkerStateForTests(): void {
  workersInitialized = false;
}
