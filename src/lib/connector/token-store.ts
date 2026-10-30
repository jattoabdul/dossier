import "server-only";

import { Prisma } from "@/generated/prisma/client";
import { prisma } from "@/lib/prisma";

/** The authorization code's signed jti is also its session id, making consumption atomic. */
export async function consumeCode(id: string, refreshId: string, expiresAt: Date): Promise<boolean> {
  await prisma.connectorSession.deleteMany({ where: { expiresAt: { lt: new Date() } } });
  try {
    await prisma.connectorSession.create({ data: { id, refreshId, expiresAt } });
    return true;
  } catch (error) {
    if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== "P2002") throw error;
    await prisma.connectorSession.updateMany({ where: { id }, data: { revoked: true } });
    return false;
  }
}

/** Compare-and-swap works across processes. Reusing a refresh token revokes its entire session. */
export async function rotateRefresh(id: string, previous: string, next: string): Promise<boolean> {
  const changed = await prisma.connectorSession.updateMany({
    where: { id, refreshId: previous, revoked: false, expiresAt: { gt: new Date() } },
    data: { refreshId: next },
  });
  if (changed.count === 1) return true;
  await prisma.connectorSession.updateMany({ where: { id }, data: { revoked: true } });
  return false;
}

export async function sessionActive(id: string): Promise<boolean> {
  return Boolean(await prisma.connectorSession.findFirst({ where: { id, revoked: false, expiresAt: { gt: new Date() } } }));
}
