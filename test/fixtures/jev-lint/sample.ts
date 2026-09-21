// Fixture for the offline "rules inactive without a key" test. It deliberately
// contains a misleading name, a contradicting comment and a useless error
// message, so all three rules select it and a request would be attempted.

/** Returns the user's profile. */
export async function getUser(id: string): Promise<void> {
  if (!id) throw new Error("Error 42");
  await Promise.resolve(id);
}
