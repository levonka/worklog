/** Clears the fields at once; if the request fails, gives the text back unless something new was typed meanwhile */
export function clearUntilFailed(fields: readonly HTMLInputElement[], request: Promise<void>): void {
  const typed = fields.map(field => field.value);
  for (const field of fields) field.value = '';
  request.catch(() => {
    if (fields.some(field => field.value !== '')) return;
    for (const [index, field] of fields.entries()) field.value = typed[index];
  });
}
