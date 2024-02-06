"use strict";

const DbService = require("db-mixin");
const ConfigLoader = require("config-mixin");
const { MoleculerClientError } = require("moleculer").Errors;

const { FtpSrv } = require('ftp-srv');
const Membership = require("membership-mixin");

const FTP_EVENTS = [
    'STOR',
    'RETR',
    'RNFR',
    'RNTO',
    'DELE',
    'MKD',
    'RMD',
    'CWD',
    'PWD',
    'LIST',
    'NLST',
    'APPE',
    'SIZE',
    'STAT',
    'REST',
    'ABOR',
    'QUIT',
    'SYST',
    'TYPE',
    'PORT',
    'PASV',
    'FEAT',
    'OPTS',
    'NOOP',
    'ALLO',
    'USER',
    'PASS',
    'ACCT',
];

// blacklist of ftp commands
const eventLenth = FTP_EVENTS.length;
for (let i = 0; i < eventLenth; i++) {
    const event = FTP_EVENTS[i];
    FTP_EVENTS.push(`!${event}`)
}

/**
 * FTP server accounts service
 */

module.exports = {
    // name of service
    name: "ftp.accounts",
    // version of service
    version: 1,

    /**
     * Service Mixins
     * 
     * @type {Array}
     * @property {DbService} DbService - Database mixin
     * @property {ConfigLoader} ConfigLoader - Config loader mixin
     */
    mixins: [
        DbService({
            permissions: 'ftp.accounts'
        }),
        ConfigLoader([
            'ftp.**'
        ]),
        Membership({
            permissions: 'ftp.accounts'
        })
    ],

    /**
     * Service dependencies
     */
    dependencies: [],

    /**
     * Service settings
     * 
     * @type {Object}
     */
    settings: {
        rest: true,

        fields: {
            // ftp username
            username: {
                type: "string",
                min: 4,
                max: 32,
                required: true,
                message: "Username must be 3-32 characters long and contain only letters and numbers"
            },
            // ftp password
            password: {
                type: "string",
                min: 8,
                max: 64,
                required: true,
                trim: true,
                message: "Password must be 8-64 characters long"
            },
            // ftp home directory
            homedir: {
                type: "string",
                min: 1,
                max: 255,
                required: true,
                trim: true,
                message: "Home directory must be 1-255 characters long"
            },
            // ftp permissions
            permissions: {
                type: "array",
                items: {
                    type: "string",
                    enum: FTP_EVENTS,
                    required: true,
                    message: `Permissions must be one of ${FTP_EVENTS.join(', ')}`
                },
                default: FTP_EVENTS.filter(e => e[0] !== '!'),
            },
            // ftp quota
            quota: {
                type: "number",
                min: 0,
                max: 1000000000,
                required: true,
                message: "Quota must be 0-1000000000"
            },
            // ftp ratio
            ratio: {
                type: "number",
                min: 0,
                max: 1000000000,
                required: true,
                message: "Ratio must be 0-1000000000"
            },
            // fs driver type
            driver: {
                type: "string",
                enum: [
                    'local', // local file system
                    's3', // AWS S3
                    'git', // git repository
                ],
                default: 'local',
                required: true,
                message: "Driver must be one of local, s3, git"
            },



            ...DbService.FIELDS,// inject dbservice fields
            ...Membership.FIELDS,
        },

        // default database populates
        defaultPopulates: [],

        // database scopes
        scopes: {
            ...DbService.SCOPE,// inject dbservice scope
            ...Membership.SCOPE,
        },

        // default database scope
        defaultScopes: [
            ...DbService.DSCOPE,
            ...Membership.DSCOPE,
        ],// inject dbservice dscope

        // default init config settings
        config: {

        }
    },

    /**
     * service actions
     */
    actions: {
        /**
         * FTP user login action
         * 
         * @actions
         * @param {String} username - FTP username
         * @param {String} password - FTP password
         * 
         * @returns {Object} FTP user
         */
        login: {
            params: {
                username: { type: "string", min: 3, max: 32, required: true },
                password: { type: "string", min: 8, max: 64, required: true },
            },
            async handler(ctx) {
                const params = Object.assign({}, ctx.params);
                this.logger.info('login', params);
                return this.login(ctx, params.username, params.password);
            }
        },

        /**
         * Find FTP user by username
         * 
         * @actions
         * @param {String} username - FTP username
         * 
         * @returns {Object} FTP user
         */
        findByName: {
            params: {
                username: { type: "string", min: 3, max: 32, required: true },
            },
            async handler(ctx) {
                const params = Object.assign({}, ctx.params);
                return this.findByName(params.username);
            }
        },

        /**
         * Create FTP user from storage provision
         * 
         * @actions
         * @param {String} username - FTP username
         * @param {String} password - FTP password
         * @param {String} provision - storage provision id
         * 
         * @returns {Object} FTP user
         */
        createFromProvision: {
            rest: {
                method: "POST",
                path: "/provision",
            },
            params: {
                username: { type: "string", min: 3, max: 32, required: true },
                password: { type: "string", min: 8, max: 64, required: true },
                provision: { type: "string", min: 3, max: 32, required: true },
            },
            async handler(ctx) {
                const params = Object.assign({}, ctx.params);

                const provision = await this.broker.call('v1.storage.provisions.get', { id: params.provision });
                if (!provision)
                    throw new MoleculerClientError("Invalid provision", 400, "INVALID_PROVISION");

                const user = await this.findByName(params.username);
                if (user)
                    throw new MoleculerClientError("User already exists", 400, "USER_EXISTS");

                const data = {
                    username: params.username,
                    password: params.password,
                    homedir:`/mnt/${provision.path}`,
                    quota: 0,
                    ratio: 0,
                };

                return this.createEntity(ctx, data);
            }
        },
    },

    /**
     * service events
     */
    events: {

    },

    /**
     * service methods
     */
    methods: {
        /**
         * FTP user login action
         * 
         * @actions
         * @param {Object} ctx - context
         * @param {String} username - FTP username
         * @param {String} password - FTP password
         * 
         * @returns {Object} FTP user
         */
        async login(ctx, username, password) {
            // lookup username  
            const user = await this.findEntity(ctx, {
                query: { username },
                scope: '-membership'
            });
            if (!user)
                throw new MoleculerClientError("Invalid credentials", 401, "INVALID_CREDENTIALS_USER");

            // check password
            const res = await this.comparePassword(password, user.password);

            if (!res)
                throw new MoleculerClientError("Invalid credentials", 401, "INVALID_CREDENTIALS_PASSWORD");

            console.log(user)
            return user;
        },

        /**
         * Compare passwords
         * 
         * @param {String} password - password to compare
         * @param {String} hash - password hash
         * 
         * @returns {Promise} - true if password matches hash
         */
        async comparePassword(password, userPassword) {
            return password === userPassword;
        },

        /**
         * Find FTP user by username
         * 
         * @param {String} username - FTP username
         * 
         * @returns {Promise} FTP user
         */
        async findByName(username) {
            return this.findEntity(null, {
                query: { username },
                scope: '-membership'
            });
        },
    },

    /**
     * Service created lifecycle event handler
     */
    created() { },

    /**
     * Service started lifecycle event handler
     */
    started() {

    },

    /**
     * Service stopped lifecycle event handler
     */
    stopped() { }
};

