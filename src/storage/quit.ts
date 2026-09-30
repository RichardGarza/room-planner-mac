import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'

/**
 * Mac app only: when the window is closed or the app quits, the Rust side asks the page to save
 * first (edits are written ~0.4 s after they happen, so the last one could still be waiting), and
 * quits once `save` is done. It quits on its own after a few seconds if this never answers.
 */
export async function saveBeforeQuit(save: () => Promise<void>) {
  await listen('save-before-quit', async () => {
    try {
      await save()
    } catch (err) {
      console.warn('Could not save before quitting', err)
    }
    await invoke('quit_after_save')
  })
}
