/** Explicit model port for lifecycle fixtures that substitute model execution. */
export function createTestDesignModelSelection() {
  const snapshot = {
    providerId: "00000000-0000-4000-8000-000000000001",
    modelId: "test-model",
    configRevision: 1,
    body: {},
    inputCapabilities: { image: false, pdf: false },
  };
  return { capture: async () => snapshot, validate: async () => {} };
}
