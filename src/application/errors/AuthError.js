const ApiError = require('./ApiError');

/**
 * Windowseven MD Authentication Error
 * Standardized error class for authentication and identity operations.
 */
class AuthError extends ApiError {
    /**
     * @param {string} message - Human-readable safe error message
     * @param {string} code - Machine-readable error code
     * @param {number} statusCode - HTTP status code
     * @param {Array} details - Additional validation error details
     */
    constructor(message, code = 'AUTHENTICATION_ERROR', statusCode = 401, details = []) {
        super(message, code, statusCode, details);
        this.name = 'AuthError';
    }
}

module.exports = AuthError;
