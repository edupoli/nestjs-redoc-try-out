import * as OpenAPISampler from 'openapi-sampler';
import { OpenAPIObject } from '@nestjs/swagger';

/**
 * Translates given OpenAPI document to an array of HTTP Archive (HAR) 1.2 Request Object.
 * See more:
 *  - http://swagger.io/specification/
 *  - http://www.softwareishard.com/blog/har-12-spec/#request
 *
 * Example HAR Request Object:
 * "request": {
 *   "method": "GET",
 *   "url": "http://www.example.com/path/?param=value",
 *   "httpVersion": "HTTP/1.1",
 *   "cookies": [],
 *   "headers": [],
 *   "queryString" : [],
 *   "postData" : {},
 *   "headersSize" : 150,
 *   "bodySize" : 0,
 *   "comment" : ""
 * }
 */

export function getEndpoint(openApi:OpenAPIObject, path: string, method:string, queryParamValues?: {}): any[] {

    queryParamValues = queryParamValues || {};

    const baseUrl = getBaseUrl(openApi, path, method);

    const baseHar = {
        method: method.toUpperCase(),
        url: baseUrl + getFullPath(openApi, path, method),
        headers: getHeadersArray(openApi, path, method),
        queryString: getQueryStrings(openApi, path, method, queryParamValues),
        httpVersion: 'HTTP/1.1',
        cookies: [],
        headersSize: 0,
        bodySize: 0,
    };

    let hars = [];

    // get payload data, if available:
    const postDatas = getPayloads(openApi, path, method);

    // For each postData create a snippet
    if (postDatas.length > 0) {
        for (const postData of postDatas) {
            const copiedHar = JSON.parse(JSON.stringify(baseHar));
            copiedHar.postData = postData;
            copiedHar.comment = postData.mimeType;
            copiedHar.headers.push({
                name: 'content-type',
                value: postData.mimeType,
            });
            hars.push(copiedHar);
        }
    } else {
        hars = [baseHar];
    }

    return hars;
};

/**
 * Get the payload definition for the given endpoint (path + method) from the
 * given OAI specification. References within the payload definition are
 * resolved.
 *
 * @param  {object} openApi
 * @param  {string} path
 * @param  {string} method
 * @return {array}  A list of payload objects
 */
const getPayloads = function (openApi, path, method) {
    if (typeof openApi.paths[path][method].parameters !== 'undefined') {
        for (const param of openApi.paths[path][method].parameters) {
            if (
                typeof param.in !== 'undefined' &&
                param.in.toLowerCase() === 'body' &&
                typeof param.schema !== 'undefined'
            ) {
                try {
                    const sample = OpenAPISampler.sample(
                        param.schema,
                        { skipReadOnly: true },
                        openApi
                    );
                    return [
                        {
                            mimeType: 'application/json',
                            text: JSON.stringify(sample),
                        },
                    ];
                } catch (err) {
                    console.log(err);
                    return null;
                }
            }
        }
    }

    if (
        openApi.paths[path][method].requestBody &&
        openApi.paths[path][method].requestBody['$ref']
    ) {
        openApi.paths[path][method].requestBody = resolveRef(
            openApi,
            openApi.paths[path][method].requestBody['$ref']
        );
    }

    const payloads = [];
    if (
        openApi.paths[path][method].requestBody &&
        openApi.paths[path][method].requestBody.content
    ) {
        [
            'application/json',
            'application/x-www-form-urlencoded',
            'multipart/form-data',
        ].forEach((type) => {
            const content = openApi.paths[path][method].requestBody.content[type];
            if (content && content.schema) {
                const sample = OpenAPISampler.sample(
                    content.schema,
                    { skipReadOnly: true },
                    openApi
                );
                if (type === 'application/json') {
                    payloads.push({
                        mimeType: type,
                        text: JSON.stringify(sample),
                    });
                } else if (type === 'multipart/form-data') {
                    if (sample !== undefined) {
                        const params = [];
                        Object.keys(sample).forEach((key) => {
                            let value = sample[key];
                            if (typeof sample[key] !== 'string') {
                                value = JSON.stringify(sample[key]);
                            }
                            params.push({ name: key, value: value });
                        });
                        payloads.push({
                            mimeType: type,
                            params: params,
                        });
                    }
                } else if (type == 'application/x-www-form-urlencoded') {
                    if (sample === undefined) return null;

                    const params = [];
                    Object.keys(sample).map((key) =>
                        params.push({
                            name: encodeURIComponent(key).replace(/\%20/g, '+'),
                            value: encodeURIComponent(sample[key]).replace(/\%20/g, '+'),
                        })
                    );

                    payloads.push({
                        mimeType: 'application/x-www-form-urlencoded',
                        params: params,
                        text: Object.keys(params)
                            .map((key) => key + '=' + sample[key])
                            .join('&'),
                    });
                }
            }
        });
    }
    return payloads;
};

/**
 * Gets the base URL constructed from the given openApi.
 *
 * @param  {Object} openApi OpenAPI document
 * @return {string}         Base URL
 */
const getBaseUrl = function (openApi, path, method) {
    if (openApi.paths[path][method].servers)
        return openApi.paths[path][method].servers[0].url;
    if (openApi.paths[path].servers) return openApi.paths[path].servers[0].url;
    if (openApi.servers) return openApi.servers[0].url;

    let baseUrl = '';
    if (typeof openApi.schemes !== 'undefined') {
        baseUrl += openApi.schemes[0];
    } else {
        baseUrl += 'http';
    }

    if (openApi.basePath === '/') {
        baseUrl += '://' + openApi.host;
    } else {
        baseUrl += '://' + openApi.host + openApi.basePath;
    }

    return baseUrl;
};

/**
 * Gets an object describing the the paremeters (header or query) in a given OpenAPI method
 * @param  {Object} param  parameter values to use in snippet
 * @param  {Object} values Optional: query parameter values to use in the snippet if present
 * @return {Object}        Object describing the parameters in a given OpenAPI method or path
 */
const getParameterValues = function (param: any, values?: any) {
    let value =
        'SOME_' + (param.type || param.schema.type).toUpperCase() + '_VALUE';
    if (values && typeof values[param.name] !== 'undefined') {
        value =
            values[param.name] + ''; /* adding a empty string to convert to string */
    } else if (typeof param.default !== 'undefined') {
        value = param.default + '';
    } else if (
        typeof param.schema !== 'undefined' &&
        typeof param.schema.example !== 'undefined'
    ) {
        value = param.schema.example + '';
    } else if (typeof param.example !== 'undefined') {
        value = param.example + '';
    }
    return {
        name: param.name,
        value: value,
    };
};

const parseParametersToQuery = function (openApi:OpenAPIObject, parameters: any, values: any): any {
    const queryStrings = {};

    for (let i in parameters) {
        let param = parameters[i];
        if (typeof param['$ref'] === 'string' && /^#/.test(param['$ref'])) {
            param = resolveRef(openApi, param['$ref']);
        }
        if (typeof param.schema !== 'undefined') {
            if (
                typeof param.schema['$ref'] === 'string' &&
                /^#/.test(param.schema['$ref'])
            ) {
                param.schema = resolveRef(openApi, param.schema['$ref']);
                if (typeof param.schema.type === 'undefined') {
                    // many schemas don't have an explicit type
                    param.schema.type = 'object';
                }
            }
        }
        if (typeof param.in !== 'undefined' && param.in.toLowerCase() === 'query') {
            // param.name is a safe key, because the spec defines
            // that name MUST be unique
            queryStrings[param.name] = getParameterValues(param, values);
        }
    }

    return queryStrings;
};

/**
 * Get array of objects describing the query parameters for a path and method
 * pair described in the given OpenAPI document.
 *
 * @param  {Object} openApi OpenApi document
 * @param  {string} path    Key of the path
 * @param  {string} method  Key of the method
 * @param  {Object} values  Optional: query parameter values to use in the snippet if present
 * @return {array}          List of objects describing the query strings
 */
const getQueryStrings = function (openApi, path, method, values) {
    // Set the optional parameter if it's not provided
    if (typeof values === 'undefined') {
        values = {};
    }

    let pathQueryStrings = {};
    let methodQueryStrings = {};

    // First get any parameters from the path
    if (typeof openApi.paths[path].parameters !== 'undefined') {
        pathQueryStrings = parseParametersToQuery(
            openApi,
            openApi.paths[path].parameters,
            values
        );
    }

    if (typeof openApi.paths[path][method].parameters !== 'undefined') {
        methodQueryStrings = parseParametersToQuery(
            openApi,
            openApi.paths[path][method].parameters,
            values
        );
    }

    // Merge query strings, with method overriding path
    // from the spec:
    // If a parameter is already defined at the Path Item, the new definition will override
    // it but can never remove it.
    // https://swagger.io/specification/
    const queryStrings = Object.assign(pathQueryStrings, methodQueryStrings);
    return Object.values(queryStrings);
};

const getFullPath = function (openApi: OpenAPIObject, path: string, method: string): string {
    let fullPath = path;
    const parameters =
        openApi.paths[path].parameters || openApi.paths[path][method].parameters;

    if (typeof parameters !== 'undefined') {
        for (let param of parameters) {
            if (typeof param['$ref'] === 'string' && /^#/.test(param['$ref'])) {
                param = resolveRef(openApi, param['$ref']);
            }
            if (
                typeof param.in !== 'undefined' &&
                param.in.toLowerCase() === 'path'
            ) {
                if (typeof param.example !== 'undefined') {
                    // only if the schema has an example value
                    fullPath = fullPath.replace('{' + param.name + '}', param.example);
                }
            }
        }
    }
    return fullPath;
};

/**
 * Get an array of objects describing the header for a path and method pair
 * described in the given OpenAPI document.
 *
 * @param  {Object} openApi OpenAPI document
 * @param  {string} path    Key of the path
 * @param  {string} method  Key of the method
 * @return {array}          List of objects describing the header
 */
const getHeadersArray = function (openApi, path, method) {
    const headers = [];
    const pathObj = openApi.paths[path][method];

    // 'accept' header:
    if (typeof pathObj.consumes !== 'undefined') {
        for (const type of pathObj.consumes) {
            headers.push({
                name: 'accept',
                value: type,
            });
        }
    }

    // headers defined in path object:
    if (typeof pathObj.parameters !== 'undefined') {
        for (const param of pathObj.parameters) {
            if (
                typeof param.in !== 'undefined' &&
                param.in.toLowerCase() === 'header'
            ) {
                headers.push(getParameterValues(param));
            }
        }
    }

    // security:
    let basicAuthDef;
    let apiKeyAuthDef;
    let oauthDef;
    if (typeof pathObj.security !== 'undefined') {
        for (const scheme of pathObj.security) {
            const secScheme = Object.keys(scheme) as any;
            const secDefinition = openApi.securityDefinitions
                ? openApi.securityDefinitions[secScheme]
                : openApi.components.securitySchemes[secScheme];
            const authType = secDefinition.type.toLowerCase();
            let authScheme = null;

            if (authType !== 'apikey' && secDefinition.scheme != null) {
                authScheme = secDefinition.scheme.toLowerCase();
            }

            switch (authType) {
                case 'basic':
                    basicAuthDef = secScheme;
                    break;
                case 'apikey':
                    if (secDefinition.in === 'header') {
                        apiKeyAuthDef = secDefinition;
                    }
                    break;
                case 'oauth2':
                    oauthDef = secScheme;
                    break;
                case 'http':
                    switch (authScheme) {
                        case 'bearer':
                            oauthDef = secScheme;
                            break;
                        case 'basic':
                            basicAuthDef = secScheme;
                            break;
                    }
                    break;
            }
        }
    } else if (typeof openApi.security !== 'undefined') {
        // Need to check OAS 3.0 spec about type http and scheme
        for (const scheme of openApi.security) {
            const secScheme = Object.keys(scheme) as any;
            const secDefinition = openApi.components.securitySchemes[secScheme];
            const authType = secDefinition.type.toLowerCase();
            let authScheme = null;

            if (authType !== 'apikey' && authType !== 'oauth2') {
                authScheme = secDefinition.scheme.toLowerCase();
            }

            switch (authType) {
                case 'http':
                    switch (authScheme) {
                        case 'bearer':
                            oauthDef = secScheme;
                            break;
                        case 'basic':
                            basicAuthDef = secScheme;
                            break;
                    }
                    break;
                case 'basic':
                    basicAuthDef = secScheme;
                    break;
                case 'apikey':
                    if (secDefinition.in === 'header') {
                        apiKeyAuthDef = secDefinition;
                    }
                    break;
                case 'oauth2':
                    oauthDef = secScheme;
                    break;
            }
        }
    }

    if (basicAuthDef) {
        headers.push({
            name: 'Authorization',
            value: 'Basic ' + 'REPLACE_BASIC_AUTH',
        });
    } else if (apiKeyAuthDef) {
        headers.push({
            name: apiKeyAuthDef.name,
            value: 'REPLACE_KEY_VALUE',
        });
    } else if (oauthDef) {
        headers.push({
            name: 'Authorization',
            value: 'Bearer ' + 'REPLACE_BEARER_TOKEN',
        });
    }

    return headers;
};

/**
 * Produces array of HAR files for given OpenAPI document
 *
 * @param  {object}   openApi          OpenAPI document
 * @param  {Function} callback
 */
export function getAll(openApi) {
    try {
        // iterate openApi and create har objects:
        const harList = [];
        for (let path in openApi.paths) {
            for (let method in openApi.paths[path]) {
                const url = getBaseUrl(openApi, path, method) + path;
                const hars = getEndpoint(openApi, path, method);
                // need to push multiple here
                harList.push({
                    method: method.toUpperCase(),
                    url: url,
                    description:
                        openApi.paths[path][method].description ||
                        'No description available',
                    hars: hars,
                });
            }
        }

        return harList;
    } catch (e) {
        console.log(e);
    }
};

/**
 * Returns the value referenced in the given reference string
 *
 * @param  {object} openApi  OpenAPI document
 * @param  {string} ref      A reference string
 * @return {any}
 */
const resolveRef = function (openApi, ref) {
    const parts = ref.split('/');

    if (parts.length <= 1) return {}; // = 3

    const recursive = function (obj, index) {
        if (index + 1 < parts.length) {
            // index = 1
            let newCount = index + 1;
            return recursive(obj[parts[index]], newCount);
        } else {
            return obj[parts[index]];
        }
    };
    return recursive(openApi, 1);
};