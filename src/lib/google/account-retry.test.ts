import { afterEach, beforeEach, expect, it, vi } from "vitest";
vi.mock("@/lib/prisma", () => ({prisma:{googleAccount:{findUnique:async()=>({scopes:"read",refreshTokenEnc:"encrypted"})}}}));
vi.mock("@/lib/secrets", () => ({decryptSecret:()=>"refresh",encryptSecret:()=>"encrypted",GOOGLE_TOKEN:{},SecretUnreadable:class extends Error{}}));
vi.mock("./oauth", () => ({googleClient:async()=>({}),hasScopes:()=>true,refreshAccessToken:async()=>({access_token:"test-token",expires_in:3600}),revokeToken:async()=>{}}));
import { googleFetch } from "./account";
const quota=()=>Response.json({error:{errors:[{reason:"rateLimitExceeded"}]}},{status:403,headers:{"retry-after":"1"}});
beforeEach(()=>vi.useFakeTimers());
afterEach(()=>{vi.useRealTimers();vi.unstubAllGlobals();});
it("retries Gmail quota 403 reads instead of reporting a permission failure",async()=>{
 const fetch=vi.fn().mockResolvedValueOnce(quota()).mockResolvedValueOnce(Response.json({id:"mail"}));vi.stubGlobal("fetch",fetch);
 const check=expect(googleFetch("read","https://gmail.googleapis.com/gmail/v1/users/me/profile")).resolves.toEqual({id:"mail"});
 await Promise.all([check, vi.advanceTimersByTimeAsync(1000)]);expect(fetch).toHaveBeenCalledTimes(2);
});
it("does not retry a genuine permission failure",async()=>{
 const fetch=vi.fn().mockResolvedValue(Response.json({error:{errors:[{reason:"insufficientPermissions"}]}},{status:403}));vi.stubGlobal("fetch",fetch);
 await expect(googleFetch("read","https://gmail.googleapis.com/gmail/v1/users/me/profile")).rejects.toMatchObject({problem:"scope"});expect(fetch).toHaveBeenCalledTimes(1);
});
it("never retries a send or other write automatically",async()=>{
 const fetch=vi.fn().mockImplementation(async()=>quota());vi.stubGlobal("fetch",fetch);
 await expect(googleFetch("send","https://gmail.googleapis.com/gmail/v1/users/me/messages/send",{method:"POST",body:{raw:"test"}})).rejects.toMatchObject({problem:"quota"});expect(fetch).toHaveBeenCalledTimes(1);
});
it("bounds read retries and preserves a quota error",async()=>{
 const fetch=vi.fn().mockImplementation(async()=>quota());vi.stubGlobal("fetch",fetch);
 const check=expect(googleFetch("read","https://gmail.googleapis.com/gmail/v1/users/me/profile")).rejects.toMatchObject({problem:"quota"});
 await Promise.all([check, vi.advanceTimersByTimeAsync(15000)]);expect(fetch).toHaveBeenCalledTimes(4);
});
