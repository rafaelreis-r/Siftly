export async function register() {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return

  try {
    // Imported lazily so the module-scope PrismaClient in lib/db is constructed inside
    // this try/catch. A static import constructs it during module evaluation, where a
    // throw escapes register() and stops the server booting.
    const { startScheduler } = await import('@/lib/x-sync')
    startScheduler()
  } catch (err) {
    console.error('[instrumentation] Failed to arm the X sync scheduler:', err)
  }
}
