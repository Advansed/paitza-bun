import type { Socket } from "socket.io";

export type AppSocket = Socket & {
  userId?: string;
  userName?: string;
  userToken?: string;
  user_type?: number;
};

export class SocketManager {
  private byType = new Map<number, Set<AppSocket>>();
  private byUser = new Map<string, Set<AppSocket>>();

  register(socket: AppSocket, user: { id?: string; name?: string; token?: string; user_type?: number }) {
    if (!user.id || user.user_type == null) return;
    socket.userId = user.id;
    socket.userName = user.name;
    socket.userToken = user.token;
    socket.user_type = user.user_type;

    if (!this.byUser.has(user.id)) this.byUser.set(user.id, new Set());
    this.byUser.get(user.id)!.add(socket);
    if (!this.byType.has(user.user_type)) this.byType.set(user.user_type, new Set());
    this.byType.get(user.user_type)!.add(socket);
  }

  unregister(socket: AppSocket) {
    if (socket.userId && this.byUser.has(socket.userId)) {
      const set = this.byUser.get(socket.userId)!;
      set.delete(socket);
      if (!set.size) this.byUser.delete(socket.userId);
    }
    if (socket.user_type != null && this.byType.has(socket.user_type)) {
      this.byType.get(socket.user_type)!.delete(socket);
    }
  }

  findSockets(userId: string) {
    const set = this.byUser.get(userId);
    if (!set) return [];
    return [...set].filter((s) => s.connected);
  }

  findSocket(userId: string) {
    return this.findSockets(userId)[0] ?? null;
  }

  findSocketsByUserType(userType: number) {
    const set = this.byType.get(userType);
    if (!set) return [];
    return [...set].filter((s) => s.connected);
  }
}
