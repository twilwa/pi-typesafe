// Fixture for the wrapper-classification test. `unusedBinding` trips an
// error-severity deterministic rule so ESLint exits 1, while the function gives
// the semantic rules something to select.
const unusedBinding = 1;

/** Returns the user's profile. */
export async function getUser(id: string): Promise<void> {
  if (!id) throw new Error("Error 42");
  await Promise.resolve(id);
}
