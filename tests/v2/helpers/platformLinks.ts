import { promises as fs } from 'node:fs';

/** A real link for refusal cases. Windows hosts may lack the file-symlink
 * privilege; a junction to `directory` is the privilege-free reparse point
 * there. POSIX and privileged Windows hosts keep the exact file-symlink case. */
export async function linkFileOrJunction(file: string, directory: string, link: string): Promise<void> {
  try { await fs.symlink(file, link); }
  catch (error) {
    if (process.platform !== 'win32' || (error as NodeJS.ErrnoException).code !== 'EPERM') throw error;
    await fs.symlink(directory, link, 'junction');
  }
}
