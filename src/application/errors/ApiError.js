/**
 * Windowseven MD Standard API Error
 * Base error class for all REST API and application domain errors.
 */
class ApiError extends Error {
    /**
     * @param {string} message - Human-readable safe error message
     * @param {string} code - Machine-readable error code
     * @param {number} statusCode - HTTP status code
     * @param {Array} details - Additional structured error details (e.g. validation fields)
     */
    constructor(message, code = 'INTERNAL_SERVER_ERROR', statusCode = 500, details = []) {
        super(message);
        this.name = this.constructor.name;
        this.code = code;
        this.statusCode = statusCode;
        this.details = details;
    }

    static badRequest(message, code = 'BAD_REQUEST', details = []) {
        return new ApiError(message, code, 400, details);
    }

    static unauthorized(message = 'Authentication is required', code = 'UNAUTHORIZED', details = []) {
        return new ApiError(message, code, 401, details);
    }

    static forbidden(message = 'Access is forbidden', code = 'FORBIDDEN', details = []) {
        return new ApiError(message, code, 403, details);
    }

    static notFound(message = 'Resource not found', code = 'RESOURCE_NOT_FOUND', details = []) {
        return new ApiError(message, code, 404, details);
    }

    static methodNotAllowed(message = 'Method not allowed', code = 'METHOD_NOT_ALLOWED', details = []) {
        return new ApiError(message, code, 405, details);
    }

    static conflict(message = 'Resource already exists or conflicts with current state', code = 'CONFLICT', details = []) {
        return new ApiError(message, code, 409, details);
    }

    static payloadTooLarge(message = 'Payload too large', code = 'PAYLOAD_TOO_LARGE', details = []) {
        return new ApiError(message, code, 413, details);
    }

    static validation(message = 'Validation failed', details = []) {
        return new ApiError(message, 'VALIDATION_ERROR', 400, details);
    }

    static unprocessableEntity(message = 'Unprocessable Entity', code = 'UNPROCESSABLE_ENTITY', details = []) {
        return new ApiError(message, code, 422, details);
    }

    static rateLimited(message = 'Too many requests, please try again later', code = 'RATE_LIMITED', details = []) {
        return new ApiError(message, code, 429, details);
    }

    static internal(message = 'An unexpected error occurred', code = 'INTERNAL_SERVER_ERROR', details = []) {
        return new ApiError(message, code, 500, details);
    }
}

module.exports = ApiError;
