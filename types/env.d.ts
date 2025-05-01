// noinspection JSUnusedGlobalSymbols

declare namespace NodeJS {
    export interface ProcessEnv {
        NODE_ENV: 'development' | 'production' | 'test';

        HTTP_HOST?: string;
        HTTP_PORT?: string;
        HTTPS_KEY_FILE?: string;
        HTTPS_CERT_FILE?: string;
        HTTP_POST_FIELD?: string;

        INCOMING_DIR?: string;
        REPO_STATE_DIR?: string;
        REPO_DIR?: string;

        SIGN_SCRIPT?: string;
        CREATEREPO_SCRIPT?: string;
        REPREPRO_BIN?: string;
        GPG_BIN?: string;
        GNUPGHOME?: string;

        DEB_ORIGIN?: string;
        DEB_DESCRIPTION?: string;

        GPG_REPO_PRIVATE_KEY_FILE?: string;
        GPG_PUBLIC_KEYS_FILE?: string;
        GPG_PUBLIC_KEYS_DIR?: string;

        UPLOAD_ALLOWED_IPS?: string;
        UPLOAD_BASIC_AUTH?: string;
        UPLOAD_SIZE_LIMIT?: string;
        UPLOAD_POST_FIELD?: string;

        [key: `DEB_ORIGIN_${ string }`]: string;

        [key: `DEB_DESCRIPTION_${ string }`]: string;

        LOG_LEVEL?: string;
    }

}
