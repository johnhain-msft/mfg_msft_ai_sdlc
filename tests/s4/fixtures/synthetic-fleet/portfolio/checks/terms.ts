export const scanText = (text: string): string[] => (text.toLowerCase().includes('hush') ? ['hush'] : []);
