export class AppError extends Error {
  constructor(status, code, message, details = null) {
    super(message);
    this.name = 'AppError';
    this.status = status;
    this.code = code;
    this.expose = true;
    if (details !== null) this.details = details;
  }
}

export const badRequest = (message = 'Некорректный запрос', details = null) =>
  new AppError(400, 'BAD_REQUEST', message, details);

export const unauthorized = (message = 'Требуется авторизация') =>
  new AppError(401, 'UNAUTHORIZED', message);

export const forbidden = (message = 'Доступ запрещён', details = null) =>
  new AppError(403, 'FORBIDDEN', message, details);

export const notFound = (message = 'Не найдено') =>
  new AppError(404, 'NOT_FOUND', message);

export const conflict = (message = 'Конфликт', details = null) =>
  new AppError(409, 'CONFLICT', message, details);

export const unprocessable = (message = 'Невозможно обработать', details = null) =>
  new AppError(422, 'UNPROCESSABLE', message, details);

export const tooManyRequests = (message = 'Слишком много запросов', details = null) =>
  new AppError(429, 'RATE_LIMITED', message, details);

export const internal = (message = 'Внутренняя ошибка') =>
  new AppError(500, 'INTERNAL_ERROR', message);

export function asyncHandler(fn) {
  return function wrapped(req, res, next) {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}

export function validationErrorFromZod(zodError) {
  const details = zodError.issues.map((i) => ({
    path: i.path.join('.') || '(root)',
    message: i.message,
  }));
  return unprocessable('Проверьте поля формы', details);
}