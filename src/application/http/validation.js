const ApiError = require('../errors/ApiError');

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Validates that a value is a valid UUID string.
 */
function validateUuid(value, fieldName = 'id') {
    if (!value || typeof value !== 'string' || !UUID_REGEX.test(value.trim())) {
        throw ApiError.badRequest(
            `Invalid ${fieldName}: must be a valid UUID`,
            'VALIDATION_ERROR',
            [{ field: fieldName, message: `Must be a valid UUID format` }]
        );
    }
    return value.trim().toLowerCase();
}

/**
 * Validates string length and presence.
 */
function validateString(value, fieldName, { min = 1, max = 255, required = true } = {}) {
    if (value === undefined || value === null || value === '') {
        if (required) {
            throw ApiError.badRequest(
                `${fieldName} is required`,
                'VALIDATION_ERROR',
                [{ field: fieldName, message: 'Field is required' }]
            );
        }
        return null;
    }

    if (typeof value !== 'string') {
        throw ApiError.badRequest(
            `${fieldName} must be a string`,
            'VALIDATION_ERROR',
            [{ field: fieldName, message: 'Must be a string' }]
        );
    }

    const trimmed = value.trim();
    if (trimmed.length < min) {
        throw ApiError.badRequest(
            `${fieldName} must be at least ${min} characters`,
            'VALIDATION_ERROR',
            [{ field: fieldName, message: `Must be at least ${min} characters` }]
        );
    }

    if (trimmed.length > max) {
        throw ApiError.badRequest(
            `${fieldName} cannot exceed ${max} characters`,
            'VALIDATION_ERROR',
            [{ field: fieldName, message: `Cannot exceed ${max} characters` }]
        );
    }

    return trimmed;
}

/**
 * Validates email syntax and normalizes to lowercase.
 */
function validateEmail(value, fieldName = 'email') {
    const str = validateString(value, fieldName, { min: 5, max: 255, required: true });
    if (!EMAIL_REGEX.test(str)) {
        throw ApiError.badRequest(
            `Invalid ${fieldName} format`,
            'VALIDATION_ERROR',
            [{ field: fieldName, message: 'Must be a valid email address' }]
        );
    }
    return str.toLowerCase();
}

/**
 * Validates that a value belongs to an allowed enumeration set.
 */
function validateEnum(value, fieldName, allowedValues) {
    if (!value || !allowedValues.includes(value)) {
        throw ApiError.badRequest(
            `Invalid ${fieldName}: '${value}'. Allowed values: ${allowedValues.join(', ')}`,
            'VALIDATION_ERROR',
            [{ field: fieldName, message: `Must be one of: ${allowedValues.join(', ')}` }]
        );
    }
    return value;
}

/**
 * Validates and extracts pagination parameters from a query object.
 * NOTE: Page size (limit) is strictly an API pagination window parameter,
 * NOT a system or SaaS capacity ceiling.
 */
function validatePagination(query = {}) {
    let page = parseInt(query.page, 10);
    if (Number.isNaN(page) || page < 1) {
        page = 1;
    }

    let limit = parseInt(query.limit, 10);
    if (Number.isNaN(limit) || limit < 1) {
        limit = 20;
    } else if (limit > 100) {
        limit = 100; // Sensible maximum page window per request
    }

    const offset = (page - 1) * limit;

    return { page, limit, offset };
}

module.exports = {
    validateUuid,
    validateString,
    validateEmail,
    validateEnum,
    validatePagination,
};
