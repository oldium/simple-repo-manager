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
        TEMPLATES_DIR?: string;

        SIGN_SCRIPT?: string;
        CREATEREPO_SCRIPT?: string;
        REPREPRO_BIN?: string;
        GPG_BIN?: string;
        GNUPGHOME?: string;

        SLUG?: string;
        REPO_NAME?: string;

        DEB_DESCRIPTION?: string;
        DEB_DISTRO_NAME?: string;
        DEB_GPG_KEY_DIR?: string;
        DEB_GPG_KEY_FILE?: string;
        DEB_ORIGIN?: string;
        DEB_RELEASE_NAME?: string;
        DEB_REPO_NAME?: string;
        DEB_SLUG?: string;
        DEB_SOURCES_LIST_DIR?: string;
        DEB_TEMPLATE?: string;

        RPM_DISTRO_NAME?: string;
        RPM_GPG_KEY_DIR?: string;
        RPM_GPG_KEY_FILE?: string;
        RPM_RELEASE_NAME?: string;
        RPM_REPO_NAME?: string;
        RPM_REPOS_DIR?: string;
        RPM_SLUG?: string;
        RPM_TEMPLATE?: string;

        GPG_REPO_PRIVATE_KEY_FILE?: string;
        GPG_PUBLIC_KEYS_FILE?: string;
        GPG_PUBLIC_KEYS_DIR?: string;

        UPLOAD_ALLOWED_IPS?: string;
        UPLOAD_BASIC_AUTH?: string;
        UPLOAD_SIZE_LIMIT?: string;
        UPLOAD_POST_FIELD?: string;

        LOG_LEVEL?: string;

        [key: `DEB_DESCRIPTION_${ string }`]: string;

        [key: `DEB_DISTRO_NAME_${ string }`]: string;

        [key: `DEB_GPG_KEY_DIR_${ string }`]: string;

        [key: `DEB_GPG_KEY_FILE_${ string }`]: string;

        [key: `DEB_ORIGIN_${ string }`]: string;

        [key: `DEB_RELEASE_NAME_${ string }`]: string;

        [key: `DEB_REPO_NAME_${ string }`]: string;

        [key: `DEB_SLUG_${ string }`]: string;

        [key: `DEB_SOURCES_LIST_DIR_${ string }`]: string;

        [key: `DEB_TEMPLATE_${ string }`]: string;

        [key: `RPM_DISTRO_NAME_${ string }`]: string;

        [key: `RPM_GPG_KEY_DIR_${ string }`]: string;

        [key: `RPM_GPG_KEY_FILE_${ string }`]: string;

        [key: `RPM_RELEASE_NAME_${ string }`]: string;

        [key: `RPM_REPO_NAME_${ string }`]: string;

        [key: `RPM_REPOS_DIR_${ string }`]: string;

        [key: `RPM_SLUG_${ string }`]: string;

        [key: `RPM_TEMPLATE_${ string }`]: string;

    }

}
