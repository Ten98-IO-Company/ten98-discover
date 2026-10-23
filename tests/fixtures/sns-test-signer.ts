// Test-only SNS signer: a self-signed RSA-2048 certificate (valid 2026-10-22 to 2126) and its key, generated for these
// fixtures with OpenSSL. It is not an AWS certificate and grants nothing; tests inject it through fetchCertificate.
import { createSign, randomUUID } from 'node:crypto';

export const snsTestTopic = 'arn:aws:sns:us-east-1:123456789012:ses-feedback';
export const snsTestCertificateUrl = 'https://sns.us-east-1.amazonaws.com/SimpleNotificationService-test.pem';
const signedFields = {
  Notification: ['Message', 'MessageId', 'Subject', 'Timestamp', 'TopicArn', 'Type'],
  SubscriptionConfirmation: ['Message', 'MessageId', 'SubscribeURL', 'Timestamp', 'Token', 'TopicArn', 'Type'],
} as const;

/** An SNS HTTP body signed as SignatureVersion 2 (SHA256withRSA over the documented field order) with the test-only key. */
export function signSnsTestMessage(type: keyof typeof signedFields, fields: Record<string, string>): string {
  const body: Record<string, string> = { Type: type, MessageId: randomUUID(), TopicArn: snsTestTopic, Timestamp: new Date().toISOString(), SignatureVersion: '2', SigningCertURL: snsTestCertificateUrl, ...fields };
  const text = signedFields[type].filter(name => body[name] !== undefined).map(name => `${name}\n${body[name]}\n`).join('');
  body.Signature = createSign('RSA-SHA256').update(text, 'utf8').sign(snsTestPrivateKey, 'base64');
  return JSON.stringify(body);
}
export const snsTestCertificate = `-----BEGIN CERTIFICATE-----
MIIDSTCCAjGgAwIBAgIUUp2yqOSO/YZt9X4TuMjH0fAitikwDQYJKoZIhvcNAQEL
BQAwMzExMC8GA1UEAwwodGVuOTgtZGlzY292ZXIgU05TIHRlc3Qgc2lnbmVyIChu
b3QgQVdTKTAgFw0yNjEwMjIyMTQ3MTZaGA8yMTI2MDkyODIxNDcxNlowMzExMC8G
A1UEAwwodGVuOTgtZGlzY292ZXIgU05TIHRlc3Qgc2lnbmVyIChub3QgQVdTKTCC
ASIwDQYJKoZIhvcNAQEBBQADggEPADCCAQoCggEBAKTYVCocKQ8NgGGDjhvjQYgB
NLEQrccv+F8uCEkPEPY+SA0/irV3vP0nwUh9w82m976qARpq4G1gkv/CIcEXIupI
HjREwpgIsnr7mzC65FMPDUcePNl72GcvpSXt/4da20IohLKaI1+v9RTf0XUGngpp
9eAAZNisdS32s+edPef3WZGbeakROz0BgScBOVmQPgU340w2LMZLp1n+LYPAtmnj
2U+hMwT15TtYzKmEyEx7+65gJUgOfjCPapwulKPpwXDkw4bfHEo5dH0hCkiMeN8+
aPgafrVWB0K+OyblV477ajYrBKsUjTcvtYRrg7dgkVdG7CAJTSLsrBHRUKVrc8cC
AwEAAaNTMFEwHQYDVR0OBBYEFKz+fltA7D6i4RAEjaAAK2D6/m1gMB8GA1UdIwQY
MBaAFKz+fltA7D6i4RAEjaAAK2D6/m1gMA8GA1UdEwEB/wQFMAMBAf8wDQYJKoZI
hvcNAQELBQADggEBAEoMfVIMNCPtiJhm9Oy2fTCIc4El5JjCLNHZJOl1LIf8mXDb
qnz0w0E24pdnBd+uw/1mucpGTUy9UH3fhLkEQrYoOZNGWDVJjYbrDDJWOj1TeOSR
G/BXfewx+1v3an4xZWrcEw5QfhD7FWTbH6B86/IjIDIUO4zk2/fPMUnkc54J7B64
GU8u1FAiRgi4od083c7O8uw0rEmkTgwFt4c7xImIlZbS6panShj3k3R0m6UH5zn/
ARM73YNk+1wrsrVz5TycP5C1MOKa2GoDxqGTX1DXsVA3XkevE16tKRer8QLfcLNJ
w+pHfTyOx/gvx2+8pEv3j+0dKcvX3yiIo47QOJo=
-----END CERTIFICATE-----`;
export const snsTestPrivateKey = `-----BEGIN PRIVATE KEY-----
MIIEvgIBADANBgkqhkiG9w0BAQEFAASCBKgwggSkAgEAAoIBAQCk2FQqHCkPDYBh
g44b40GIATSxEK3HL/hfLghJDxD2PkgNP4q1d7z9J8FIfcPNpve+qgEaauBtYJL/
wiHBFyLqSB40RMKYCLJ6+5swuuRTDw1HHjzZe9hnL6Ul7f+HWttCKISymiNfr/UU
39F1Bp4KafXgAGTYrHUt9rPnnT3n91mRm3mpETs9AYEnATlZkD4FN+NMNizGS6dZ
/i2DwLZp49lPoTME9eU7WMyphMhMe/uuYCVIDn4wj2qcLpSj6cFw5MOG3xxKOXR9
IQpIjHjfPmj4Gn61VgdCvjsm5VeO+2o2KwSrFI03L7WEa4O3YJFXRuwgCU0i7KwR
0VCla3PHAgMBAAECggEAAJbcP07cv9tP7ZuZpU/gYc+D3UdTINsp5v99amDf+zg7
fkd9BAbGIHhpoHnbw59NLtuYJ7NzQMxGcRzD+0S7DF2lopEOpZo0pJB619UuoqHz
JHzM5lD+c+kfsXHgXbE44t3yNuyqtf4AwSXHHVdp24H1dw+JTMGREtD90V4miVya
9wJ/2MhHKx7P8IF4q2qTA7C0tGJX9eF4VCD6NEN6rxheSEO05N88LO6c4FJai2hA
zObx9AONqpDNSUlt+oSwAMvcEjQFImjwvPW4Pm1rkN7He5oN+dlDTIPqc/hg8Z6i
gvy7hr0eOzKBL8/jJPUv0isplDivO3fayRe+kBpDQQKBgQDZvLnO8W+DI4BYFJDJ
P/w2mPHBUFFdeOdqR96VEUsvgwtyEiWth5uPtHJ1wRH8uVaDqntAvjMRsv02BAAl
H5CWo0TUrvKEDnzNhDsiKHejNJqL0lQuBePaO8X47ldtyABm8kqLpbwznQ1OGy91
qHOouRaMJzkWPjga8kGYzgw6vQKBgQDB0CjZFSdkdt84zXalc7E3hi35dNETvXet
llDe5WFymxS2eH/gBLRZtw2Sw9OQ1MW10PjgDnRvy2unso9k9ZJagjk1pJ/k4C6Z
CFHcGeRzodVt5ueOmwxlJwweIXrOnjsucuhXQdTK5YGEGWNIc7b8DdEedbc2Gibd
gzJvlEjS0wKBgQDDYLS+PCka3GVTJAkTfQXdG/p6w45vOIk29gyFaII1vPotPplu
j+uH1JyMi1WPl+NIvFZirwj2Tc0mhgp3RU6hzRl7WwykcLeOVqQVL4jC+vXelzoQ
Hhrp/Y7Uo1HyYW/y8GDx1CL/kWKZ/ozkn+ZAtOzFkICKNAR2MYGpEuMoZQKBgFbu
GdQ8g72w/7BHn+bX/G3OFkLkXX7AJbTLThybv9iarHCnnZuKIKZ4z3K7uOImPUOu
pmJAuYMHN5MxKNX8u5cy/5wK6djLoLrtG2JgjrI6rTMtNUEmVCnumKXPGHkiSaMs
0P+KPHqA9FWe2YQ+up1VSS2jWPjARBxo4y9e0EcXAoGBAL+oCQZae4XQsu5IQ24n
qLybKbxSa2apu6FA9zpxa2DYsWitQqqCXxZbEA8kPuBjd+M8Me+laEz5eu6Mtt8k
jbZ02y706PdPAqUBvpOT0rKzsEMNDqNuK5JPn/W9ShB+elSdXG3YHVNBKwng2Hp8
sHe+G56T5XqUKawz2vPTRU4z
-----END PRIVATE KEY-----`;
