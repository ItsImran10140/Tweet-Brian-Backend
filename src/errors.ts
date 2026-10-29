export class AppError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public hint?: string,
    public details?: unknown,
  ) {
    super(message);
    this.name = 'AppError';
  }
}
