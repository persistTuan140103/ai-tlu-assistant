import axios, { AxiosError, AxiosResponse } from 'axios';
import * as vscode from 'vscode';
import {
    authentication,
    AuthenticationProvider,
    AuthenticationProviderAuthenticationSessionsChangeEvent,
    AuthenticationSession,
    Disposable,
    ExtensionContext,
    InputBoxOptions,
    ProgressLocation,
    window
} from 'vscode';
import { SecretStorage } from './SecretStorage';

/**
 * Interface định nghĩa phản hồi token
 */
interface TokenResponse {
  token: string;
  expiresAt?: number;
}

/**
 * Interface định nghĩa thông tin người dùng
 */
interface UserInfo {
  id: string;
  name: string;
  email?: string;
}

/**
 * Interface định nghĩa kết quả từ việc xác thực token
 */
interface TokenValidationResult {
  valid: boolean;
  expiresAt?: number;
}

/**
 * Interface định nghĩa thông tin đăng nhập
 */
interface LoginCredentials {
  username: string;
  password: string;
}

export class MyAuthenticationProvider implements AuthenticationProvider, Disposable {
    private _sessionChangeEmitter: vscode.EventEmitter<AuthenticationProviderAuthenticationSessionsChangeEvent>;
    private _sessions: Map<string, AuthenticationSession>;
    private _disposable: Disposable;
   
    private static readonly TYPE: string = 'custom-auth';
    private static readonly AUTH_NAME: string = 'TluAuthProvider';
    private readonly sessionKey: string;
    private readonly secretStorage: SecretStorage;

    constructor(
        private readonly context: ExtensionContext,
    ) {
        this._sessionChangeEmitter = new vscode.EventEmitter<AuthenticationProviderAuthenticationSessionsChangeEvent>();
        this._sessions = new Map<string, AuthenticationSession>();
        this.sessionKey = 'custom-auth-session';
        
        this._disposable = Disposable.from(
            authentication.registerAuthenticationProvider(
                MyAuthenticationProvider.TYPE,
                MyAuthenticationProvider.AUTH_NAME,
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
        window.showErrorMessage(`${MyAuthenticationProvider.AUTH_NAME}: ${message}`);
    }

    /**
     * Hiển thị thông báo thông tin trong VSCode
     */
    private showInfoMessage(message: string): void {
        window.showInformationMessage(`${MyAuthenticationProvider.AUTH_NAME}: ${message}`);
    }

    /**
     * Khởi tạo provider, khôi phục sessions từ storage
     */
    private async initialize(): Promise<void> {
        try {
            const storedSessions: string | undefined = await this.secretStorage.get(this.sessionKey);
            if (storedSessions) {
                const sessions: AuthenticationSession[] = JSON.parse(storedSessions);
                for (const session of sessions) {
                    this._sessions.set(session.id, session);
                }
                
                // Kiểm tra tính hợp lệ của session đã lưu
                await this.validateSessions();
            }
        } catch (error) {
            const errorMessage: string = error instanceof Error ? error.message : 'Lỗi không xác định';
            this.showErrorMessage(`Lỗi khi khôi phục phiên: ${errorMessage}`);
        }
    }

    /**
     * Kiểm tra và xóa các session không hợp lệ hoặc hết hạn
     */
    private async validateSessions(): Promise<void> {
        const expiredSessions: AuthenticationSession[] = [];
        
        for (const session of this._sessions.values()) {
            try {
                // Kiểm tra tính hợp lệ của token
                const isValid: boolean = await this.validateToken(session.accessToken);
                if (!isValid) {
                    expiredSessions.push(session);
                }
            } catch (error) {
                expiredSessions.push(session);
            }
        }
        
        // Xóa các session đã hết hạn
        if (expiredSessions.length > 0) {
            for (const session of expiredSessions) {
                this._sessions.delete(session.id);
            }
            
            // Cập nhật storage và thông báo thay đổi
            await this.persistSessions();
            this._sessionChangeEmitter.fire({ 
                added: [], 
                removed: expiredSessions, 
                changed: [] 
            });
            
            if (expiredSessions.length > 0) {
                this.showInfoMessage("Một số phiên đăng nhập đã hết hạn và đã được xóa.");
            }
        }
    }

    /**
     * Kiểm tra tính hợp lệ của token
     */
    private async validateToken(token: string): Promise<boolean> {
        try {
            const response: AxiosResponse<TokenValidationResult> = await axios.post<TokenValidationResult>(
                'https://your-api-server.com/validate-token', 
                { token }
            );
            return response.data.valid === true;
        } catch (error) {
            return false;
        }
    }

    /**
     * Lưu sessions vào bộ nhớ bền vững
     */
    private async persistSessions(): Promise<void> {
        const sessions: AuthenticationSession[] = Array.from(this._sessions.values());
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
        // Kiểm tra xem có cần lọc theo scopes hay không
        if (!scopes || scopes.length === 0) {
            return Array.from(this._sessions.values());
        }
        
        // Lọc các session theo scopes được yêu cầu
        return Array.from(this._sessions.values()).filter(session => {
            return scopes.every(scope => session.scopes.includes(scope));
        });
    }

    /**
     * Hiển thị input box để người dùng nhập thông tin đăng nhập
     */
    private async promptForCredentials(): Promise<LoginCredentials> {
        const usernameOptions: InputBoxOptions = {
            title: 'Đăng nhập vào hệ thống',
            prompt: 'Nhập tên đăng nhập của bạn',
            ignoreFocusOut: true
        };
        
        const username = await window.showInputBox(usernameOptions);
        if (!username) {
            throw new Error('Đăng nhập đã bị hủy');
        }
        
        const passwordOptions: InputBoxOptions = {
            title: 'Đăng nhập vào hệ thống',
            prompt: 'Nhập mật khẩu của bạn',
            password: true,
            ignoreFocusOut: true
        };
        
        const password = await window.showInputBox(passwordOptions);
        if (!password) {
            throw new Error('Đăng nhập đã bị hủy');
        }
        
        return { username, password };
    }

    /**
     * Tạo một session mới thông qua quá trình xác thực
     */
    async createSession(scopes: string[]): Promise<AuthenticationSession> {
        return await window.withProgress<AuthenticationSession>(
            {
                location: ProgressLocation.Notification,
                title: "Đang đăng nhập...",
                cancellable: false
            },
            async (progress) => {
                try {
                    progress.report({ message: "Đang lấy thông tin đăng nhập..." });
                    const credentials = await this.promptForCredentials();
                    
                    progress.report({ message: "Đang xác thực..." });
                    const token = await this.getTokenWithCredentials(credentials, scopes);
                    
                    progress.report({ message: "Đang lấy thông tin người dùng..." });
                    const userInfo = await this.getUserInfo(token);
                    
                    // Tạo một session mới
                    const session: AuthenticationSession = {
                        id: userInfo.id,
                        accessToken: token,
                        account: {
                            label: userInfo.name,
                            id: userInfo.id
                        },
                        scopes: scopes
                    };
                    
                    // Lưu session vào map và persistent storage
                    this._sessions.set(session.id, session);
                    await this.persistSessions();
                    
                    // Thông báo thay đổi
                    this._sessionChangeEmitter.fire({ 
                        added: [session], 
                        removed: [], 
                        changed: [] 
                    });
                    
                    this.showInfoMessage(`Đăng nhập thành công với tài khoản ${userInfo.name}`);
                    return session;
                } catch (error) {
                    const errorMessage: string = error instanceof Error ? error.message : 'Lỗi không xác định';
                    this.showErrorMessage(`Đăng nhập thất bại: ${errorMessage}`);
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
                        
                        // Gọi API để vô hiệu hóa token
                        try {
                            await this.revokeToken(session.accessToken);
                        } catch (error) {
                            // Ghi log lỗi nhưng không dừng quá trình đăng xuất
                            const errorMessage: string = error instanceof Error ? error.message : 'Lỗi không xác định';
                            console.error(`Lỗi khi vô hiệu hóa token: ${errorMessage}`);
                        }
                        
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
    async refreshSession(sessionId: string): Promise<AuthenticationSession> {
        const session: AuthenticationSession | undefined = this._sessions.get(sessionId);
        if (!session) {
            this.showErrorMessage(`Không tìm thấy phiên với ID ${sessionId}`);
            throw new Error(`Phiên với ID ${sessionId} không tồn tại`);
        }
        
        return await window.withProgress<AuthenticationSession>(
            {
                location: ProgressLocation.Notification,
                title: "Đang làm mới phiên...",
                cancellable: false
            },
            async () => {
                try {
                    // Làm mới token
                    const newToken: string = await this.refreshToken(session.accessToken);
                    
                    // Cập nhật session
                    const updatedSession: AuthenticationSession = {
                        ...session,
                        accessToken: newToken
                    };
                    
                    // Lưu session đã cập nhật
                    this._sessions.set(sessionId, updatedSession);
                    await this.persistSessions();
                    
                    // Thông báo thay đổi
                    this._sessionChangeEmitter.fire({ 
                        added: [], 
                        removed: [], 
                        changed: [updatedSession] 
                    });
                    
                    this.showInfoMessage("Phiên đã được làm mới thành công");
                    return updatedSession;
                } catch (error) {
                    const errorMessage: string = error instanceof Error ? error.message : 'Lỗi không xác định';
                    this.showErrorMessage(`Không thể làm mới phiên: ${errorMessage}`);
                    throw new Error(`Không thể làm mới phiên: ${errorMessage}`);
                }
            }
        );
    }

    /**
     * Lấy token với thông tin đăng nhập
     */
    private async getTokenWithCredentials(credentials: LoginCredentials, scopes: string[]): Promise<string> {
        try {
            const response: AxiosResponse<TokenResponse> = await axios.post<TokenResponse>(
                'https://your-api-server.com/auth/login',
                {
                    username: credentials.username,
                    password: credentials.password,
                    scopes: scopes.join(' ')
                }
            );
            
            if (!response.data || !response.data.token) {
                throw new Error('Phản hồi không chứa token');
            }
            
            return response.data.token;
        } catch (error) {
            const axiosError = error as AxiosError;
            if (axiosError.response) {
                if (axiosError.response.status === 401) {
                    throw new Error('Tên đăng nhập hoặc mật khẩu không chính xác');
                } else {
                    throw new Error(`Lỗi xác thực: ${axiosError.response.status} - ${axiosError.response.statusText}`);
                }
            }
            throw new Error('Không thể kết nối đến máy chủ xác thực');
        }
    }

    /**
     * Làm mới token
     */
    private async refreshToken(oldToken: string): Promise<string> {
        try {
            const response: AxiosResponse<TokenResponse> = await axios.post<TokenResponse>(
                'https://your-api-server.com/auth/refresh-token', 
                { token: oldToken }
            );
            return response.data.token;
        } catch (error) {
            const axiosError = error as AxiosError;
            if (axiosError.response) {
                if (axiosError.response.status === 401) {
                    throw new Error('Token không hợp lệ hoặc đã hết hạn');
                } else {
                    throw new Error(`Lỗi làm mới token: ${axiosError.response.status} - ${axiosError.response.statusText}`);
                }
            }
            throw new Error('Không thể kết nối đến máy chủ xác thực');
        }
    }

    /**
     * Vô hiệu hóa token
     */
    private async revokeToken(token: string): Promise<void> {
        try {
            await axios.post('https://your-api-server.com/auth/revoke-token', { token });
        } catch (error) {
            const axiosError = error as AxiosError;
            if (axiosError.response) {
                throw new Error(`Lỗi hủy token: ${axiosError.response.status} - ${axiosError.response.statusText}`);
            }
            throw new Error('Không thể kết nối đến máy chủ xác thực');
        }
    }

    /**
     * Lấy thông tin người dùng từ token
     */
    private async getUserInfo(token: string): Promise<UserInfo> {
        try {
            const response: AxiosResponse<UserInfo> = await axios.get<UserInfo>(
                'https://your-api-server.com/auth/userinfo',
                {
                    headers: {
                        Authorization: `Bearer ${token}`
                    }
                }
            );
            return response.data;
        } catch (error) {
            const axiosError = error as AxiosError;
            if (axiosError.response) {
                throw new Error(`Không thể lấy thông tin người dùng: ${axiosError.response.status} - ${axiosError.response.statusText}`);
            }
            throw new Error('Không thể kết nối đến máy chủ xác thực');
        }
    }
}