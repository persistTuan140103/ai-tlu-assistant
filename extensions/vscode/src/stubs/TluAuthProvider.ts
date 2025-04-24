import * as vscode from 'vscode';
import {
    authentication,
    AuthenticationProvider,
    AuthenticationProviderAuthenticationSessionsChangeEvent,
    AuthenticationSession,
    Disposable,
    ExtensionContext,
    ProgressLocation,
    window
} from 'vscode';
import { SecretStorage } from './SecretStorage';

interface TluAuthOption extends vscode.AuthenticationSession {
    expiresTime?: number;
}

interface CallbackVscode{
    access_token: string;
    displayName: string;
    email: string;
    active: boolean;
  }

/**
 * Interface định nghĩa phản hồi token
 */
interface LoginResponse {
    access_token: string;
    refresh_token?: string;
}

/**
 * Interface định nghĩa thông tin người dùng
 */
interface UserInfo {
    id: string;
    username: string;
    displayName: string;
    email: string;
    active: boolean;
}

/**
 * Interface định nghĩa thông tin đăng nhập
 */
interface LoginCredentials {
    username: string;
    password: string;
}

export class TluAuthenticationProvider implements AuthenticationProvider, Disposable {
    private _sessionChangeEmitter: vscode.EventEmitter<AuthenticationProviderAuthenticationSessionsChangeEvent>;
    private _sessions: Map<string, TluAuthOption>;
    private _disposable: Disposable;

    public static readonly AUTH_TYPE: string = 'tlu-auth';
    private static readonly AUTH_NAME: string = 'TluAuthProvider';
    private static readonly BASE_URL: string = 'https://localhost:7199/api';
    private readonly loginPageUrl: string = 'https://web.groupten.lol/login';
    private readonly sessionKey: string;
    private readonly secretStorage: SecretStorage;

    constructor(
        private readonly context: ExtensionContext,
    ) {
        this._sessionChangeEmitter = new vscode.EventEmitter<AuthenticationProviderAuthenticationSessionsChangeEvent>();
        this._sessions = new Map<string, AuthenticationSession>();
        this.sessionKey = 'tlu-auth-sessions';

        // this._disposable = Disposable.from(this._sessionChangeEmitter);
        this._disposable = Disposable.from(
            authentication.registerAuthenticationProvider(
                TluAuthenticationProvider.AUTH_TYPE,
                TluAuthenticationProvider.AUTH_NAME,
                this,
                { supportsMultipleAccounts: false },
            )
        );

        this.secretStorage = new SecretStorage(context);

        // Khởi tạo sessions
        this.initialize().catch((error: Error) => {
            this.showErrorMessage(`Không thể khởi tạo phiên đăng nhập: ${error.message}`);
        });
    }

    /**
     * Hiển thị thông báo lỗi trong VSCode
     */
    private showErrorMessage(message: string): void {
        window.showErrorMessage(`${TluAuthenticationProvider.AUTH_NAME}: ${message}`);
    }

    /**
     * Hiển thị thông báo thông tin trong VSCode
     */
    private showInfoMessage(message: string): void {
        window.showInformationMessage(`${TluAuthenticationProvider.AUTH_NAME}: ${message}`);
    }

    /**
     * Khởi tạo provider, khôi phục sessions từ storage
     */
    private async initialize(): Promise<void> {
        try {
            const storedSessions: string | undefined = await this.secretStorage.get(this.sessionKey);
            if (storedSessions) {
                const sessions: TluAuthOption[] = JSON.parse(storedSessions);
                for (const session of sessions) {
                    // Kiểm tra xem session có còn hợp lệ không
                    if (session.expiresTime && session.expiresTime < Date.now()) {
                        this.showInfoMessage(`Phiên ${session.id} đã hết hạn và sẽ không được khôi phục`);
                        continue;
                    }
                    this._sessions.set(session.id, session);
                }
            }
        } catch (error) {
            const errorMessage: string = error instanceof Error ? error.message : 'Lỗi không xác định';
            this.showErrorMessage(`Lỗi khi khôi phục phiên: ${errorMessage}`);
        }
    }

    /**
     * Lưu sessions vào bộ nhớ bền vững
     */
    private async persistSessions(): Promise<void> {
        const sessions: TluAuthOption[] = Array.from(this._sessions.values());
        await this.secretStorage.store(this.sessionKey, JSON.stringify(sessions));
    }

    dispose(): void {
        this._disposable.dispose();
    }

    get onDidChangeSessions(): vscode.Event<AuthenticationProviderAuthenticationSessionsChangeEvent> {
        return this._sessionChangeEmitter.event;
    }

    /**
     * Lấy danh sách sessions, có thể lọc theo scopes
     */
    async getSessions(scopes?: string[]): Promise<AuthenticationSession[]> {
        return Array.from(this._sessions.values())
    }

    /**
     * Tạo một session mới thông qua quá trình xác thực
     */
    async createSession(scopes: string[]): Promise<AuthenticationSession> {
        return await window.withProgress<AuthenticationSession>(
            {
                location: ProgressLocation.Notification,
                title: "Đang đăng nhập...",
                cancellable: true
            },
            async (progress) => {
                try {
                    // progress.report({ message: "Đang lấy thông tin đăng nhập..." });
                    
                    const loginResponse: CallbackVscode = await handleAngularAuth(this.loginPageUrl, scopes);
                    // progress.report({ message: "Đang xác thực..." });

                    // const userInfo: UserInfo = await this.getUserInfo(loginResponse.access_token);
                    // if (!userInfo.active) {
                    //     throw new Error('Tài khoản không hoạt động');
                    // }
                    // Tạo một session mới
                    const session: AuthenticationSession = {
                        id: loginResponse.email,
                        accessToken: loginResponse.access_token,
                        account: {
                            label: loginResponse.displayName,
                            id: loginResponse.email
                        },
                        scopes: scopes
                    };

                    // Lưu session vào map và persistent storage
                    this._sessions.set(session.id, {
                        ...session,
                        expiresTime: Date.now() + (24 * 60 * 60 * 1000) // 24 giờ
                    });
                    await this.persistSessions();

                    // Thông báo thay đổi
                    this._sessionChangeEmitter.fire({
                        added: [session],
                        removed: [],
                        changed: []
                    });

                    this.showInfoMessage(`Đăng nhập thành công với tài khoản ${loginResponse.displayName}`);
                    return session;
                } catch (error) {
                    const errorMessage: string = error instanceof Error ? error.message : 'Lỗi không xác định';
                    this.showErrorMessage(`Tạo session faild: ${errorMessage}`);
                    throw new Error(`Không thể tạo phiên: ${errorMessage}`);
                }
            }
        );
    }

    /**
     * Xóa một session
     */
    async removeSession(sessionId: string): Promise<void> {
        const session: AuthenticationSession | undefined = this._sessions.get(sessionId);
        if (session) {
            return await window.withProgress<void>(
                {
                    location: ProgressLocation.Notification,
                    title: "Đang đăng xuất...",
                    cancellable: false
                },
                async () => {
                    try {
                        // Xóa session từ map
                        this._sessions.delete(sessionId);

                        // Cập nhật persistent storage
                        await this.persistSessions();

                        // Thông báo thay đổi
                        this._sessionChangeEmitter.fire({
                            added: [],
                            removed: [session],
                            changed: []
                        });

                        this.showInfoMessage("Đăng xuất thành công");
                    } catch (error) {
                        const errorMessage: string = error instanceof Error ? error.message : 'Lỗi không xác định';
                        this.showErrorMessage(`Đăng xuất thất bại: ${errorMessage}`);
                        throw new Error(`Không thể xóa phiên: ${errorMessage}`);
                    }
                }
            );
        }
    }

    /**
     * Làm mới một session hiện có
     */
    // async refreshSession(sessionId: string): Promise<AuthenticationSession> {
    //     const session: AuthenticationSession | undefined = this._sessions.get(sessionId);
    //     if (!session) {
    //         this.showErrorMessage(`Không tìm thấy phiên với ID ${sessionId}`);
    //         throw new Error(`Phiên với ID ${sessionId} không tồn tại`);
    //     }

    //     return await window.withProgress<AuthenticationSession>(
    //         {
    //             location: ProgressLocation.Notification,
    //             title: "Đang làm mới phiên...",
    //             cancellable: false
    //         },
    //         async () => {
    //             try {
    //                 // Làm mới token
    //                 const newToken: string = await this.refreshToken(session.accessToken);

    //                 // Cập nhật session
    //                 const updatedSession: AuthenticationSession = {
    //                     ...session,
    //                     accessToken: newToken
    //                 };

    //                 // Lưu session đã cập nhật
    //                 this._sessions.set(sessionId, updatedSession);
    //                 await this.persistSessions();

    //                 // Thông báo thay đổi
    //                 this._sessionChangeEmitter.fire({
    //                     added: [],
    //                     removed: [],
    //                     changed: [updatedSession]
    //                 });

    //                 this.showInfoMessage("Phiên đã được làm mới thành công");
    //                 return updatedSession;
    //             } catch (error) {
    //                 const errorMessage: string = error instanceof Error ? error.message : 'Lỗi không xác định';
    //                 this.showErrorMessage(`Không thể làm mới phiên: ${errorMessage}`);
    //                 throw new Error(`Không thể làm mới phiên: ${errorMessage}`);
    //             }
    //         }
    //     );
    // }

    /**
     * Lấy token với thông tin đăng nhập
     */
    private async getTokenWithCredentials(credentials: LoginCredentials, scopes: string[]): Promise<LoginResponse> {
        try {
            const response = await fetch(`${TluAuthenticationProvider.BASE_URL}/tlu/login`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    username: credentials.username,
                    password: credentials.password
                })
            });
            const data: LoginResponse = await response.json();

            if (!data || !data.access_token) {
                throw new Error('Phản hồi không chứa token');
            }

            return data;
        } catch (error) {
            if (error instanceof Error) {
                throw new Error(`Lỗi xác thực: ${error.message}`);
            }
            throw new Error('Không thể kết nối đến máy chủ xác thực');
        }
    }

    /**
     * Lấy thông tin người dùng từ token
     */
    private async getUserInfo(access_token: string): Promise<UserInfo> {
        try {
            console.debug('Fetching user 1 info...');
            const response = await fetch("https://localhost:7199/api/tlu/get-user-infor", {
                method: 'GET',
                headers: {
                    'Authorization': "Bearer " + access_token,
                    'Accept': 'text/plain'
                }
            });
            console.debug('Response received:', response);
            const data: UserInfo = await response.json();
            if (data.active == false) {
                throw new Error('Tài khoản không hoạt động');
            }
            return data;
        } catch (error) {
            if (error instanceof Error) {
                throw new Error(`Không thể lấy thông tin người dùng: ${error.message}`);
            }
            throw new Error('Không thể kết nối đến máy chủ xác thực');
        }
    }
}

/**
 * handleAngularAuth - Hàm xử lý xác thực cho Angular
 * @param loginUrl 
 * @param scopes 
 * @returns 
 */

export async function handleAngularAuth(
    loginUrl: string = 'http://localhost:4200/login',
    scopes: string[] = []
): Promise<CallbackVscode> {

    // Tạo URI callback cho VSCode
    const callbackUri = await vscode.env.asExternalUri(
        vscode.Uri.parse(`${vscode.env.uriScheme}://AI-TLU.ai-tlu-assistant/did-authenticate`)
    );

    // Tạo state ngẫu nhiên để phòng chống CSRF
    const state = Math.random().toString(36).substring(2, 15);

    // Xây dựng URL login với các tham số cần thiết
    const authUrl = new URL(loginUrl);
    authUrl.searchParams.append('redirect_uri', callbackUri.toString());
    authUrl.searchParams.append('state', state);
    // authUrl.searchParams.append('scopes', scopes.join(' '));

    // Mở URL trong trình duyệt
    await vscode.env.openExternal(vscode.Uri.parse(authUrl.toString()));

    // Xử lý callback từ Angular login page
    return new Promise<CallbackVscode>((resolve, reject) => {
        const disposable = vscode.window.registerUriHandler({
            handleUri: async (uri: vscode.Uri) => {
                try {
                    // Phân tích query từ callback URI
                    const query = new URLSearchParams(uri.query);
                    const returnedState = query.get('state');
                    const access_token = query.get('access_token');
                    const displayName = query.get('displayName');
                    const email = query.get('email');
                    const active = query.get('active') === 'true';

                    // Kiểm tra state để ngăn CSRF
                    if (returnedState !== state) {
                        throw new Error('State mismatch in authentication flow');
                    }

                    if (!access_token) {
                        throw new Error('Authentication failed: No token received');
                    }

                    // Hoàn thành promise với thông tin người dùng
                    disposable.dispose();
                    resolve({
                        access_token: access_token,
                        displayName: displayName || 'Unknown',
                        email: email || 'Unknown',
                        active: active || false
                    });

                    // Hiển thị thông báo thành công
                    vscode.window.showInformationMessage('Đăng nhập thành công!');
                } catch (error) {
                    disposable.dispose();
                    reject(error);
                    vscode.window.showErrorMessage(`Đăng nhập thất bại: ${error instanceof Error ? error.message : 'Unknown error'}`);
                }
            }
        });

        // Timeout để hủy sau 5 phút nếu không có callback
        setTimeout(() => {
            disposable.dispose();
            reject(new Error('Authentication timed out after 5 minutes'));
            vscode.window.showErrorMessage('Đăng nhập hết hạn, vui lòng thử lại');
        }, 5 * 60 * 1000);
    });
}