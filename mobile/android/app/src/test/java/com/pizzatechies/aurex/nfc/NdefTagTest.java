package com.pizzatechies.aurex.nfc;

import static org.junit.Assert.assertArrayEquals;
import static org.junit.Assert.assertEquals;

import java.io.ByteArrayOutputStream;
import java.nio.charset.StandardCharsets;
import java.util.Arrays;
import org.junit.Test;

/** Plays the commands a phone's NFC reader sends to a Type 4 tag, and reads the link back. */
public class NdefTagTest {
    private static byte[] apdu(String hex) {
        return NdefTag.hex(hex.replace(" ", ""));
    }

    private static byte[] status(byte[] response) {
        return Arrays.copyOfRange(response, response.length - 2, response.length);
    }

    private static byte[] body(byte[] response) {
        return Arrays.copyOf(response, response.length - 2);
    }

    /** The full read sequence: select the NDEF app, read the capability container, then the NDEF file in chunks. */
    private static String readLink(NdefTag tag) {
        NdefTag.Session s = tag.newSession();
        assertArrayEquals(NdefTag.OK, s.process(apdu("00 A4 04 00 07 D2760000850101 00")));
        assertArrayEquals(NdefTag.OK, s.process(apdu("00 A4 00 0C 02 E103")));
        byte[] cc = s.process(apdu("00 B0 0000 0F"));
        assertArrayEquals(NdefTag.OK, status(cc));
        assertEquals(15, body(cc).length);
        assertArrayEquals(new byte[] {(byte) 0xE1, 0x04}, Arrays.copyOfRange(body(cc), 9, 11));
        assertEquals((byte) 0xFF, body(cc)[14]); // nobody may write
        assertArrayEquals(NdefTag.OK, s.process(apdu("00 A4 00 0C 02 E104")));
        byte[] nlen = body(s.process(apdu("00 B0 0000 02")));
        int len = ((nlen[0] & 0xFF) << 8) | (nlen[1] & 0xFF);
        ByteArrayOutputStream msg = new ByteArrayOutputStream();
        int offset = 2;
        while (msg.size() < len) {
            int want = Math.min(0x3B, len - msg.size());
            byte[] r = s.process(new byte[] {0x00, (byte) 0xB0, (byte) (offset >> 8), (byte) offset, (byte) want});
            assertArrayEquals(NdefTag.OK, status(r));
            msg.write(body(r), 0, body(r).length);
            offset += body(r).length;
        }
        return decodeUri(msg.toByteArray());
    }

    /** Decodes a single well-known URI record (short or long form). */
    private static String decodeUri(byte[] m) {
        boolean sr = (m[0] & 0x10) != 0;
        assertEquals(0x01, m[0] & 0x07); // TNF well-known
        assertEquals(1, m[1]);
        int payloadLength;
        int i;
        if (sr) {
            payloadLength = m[2] & 0xFF;
            i = 3;
        } else {
            payloadLength = ((m[2] & 0xFF) << 24) | ((m[3] & 0xFF) << 16) | ((m[4] & 0xFF) << 8) | (m[5] & 0xFF);
            i = 6;
        }
        assertEquals('U', m[i++]);
        String[] prefixes = {"", "http://www.", "https://www.", "http://", "https://"};
        String prefix = prefixes[m[i++]];
        return prefix + new String(m, i, payloadLength - 1, StandardCharsets.UTF_8);
    }

    @Test
    public void aReaderGetsThePayLinkBack() {
        String url = "https://aurex.dpdns.org/pay/@amina?amount=1500&currency=KES&note=Kitenge%20fabric";
        assertEquals(url, readLink(new NdefTag(url)));
        // The https:// prefix is stored as one byte, as readers expect.
        assertEquals(4, NdefTag.uriMessage(url)[4]);
    }

    @Test
    public void longLinksUseTheLongRecordForm() {
        StringBuilder note = new StringBuilder();
        for (int i = 0; i < 40; i++) note.append("chakula%20");
        String url = "https://aurex.dpdns.org/pay/@amina?note=" + note;
        assertEquals(0xC1, NdefTag.uriMessage(url)[0] & 0xFF);
        assertEquals(url, readLink(new NdefTag(url)));
    }

    @Test
    public void refusesWritesAndUnknownFilesAndApps() {
        NdefTag.Session s = new NdefTag("https://aurex.dpdns.org/pay/@amina").newSession();
        assertArrayEquals(NdefTag.NOT_FOUND, s.process(apdu("00 A4 00 0C 02 E104"))); // before selecting the app
        assertArrayEquals(NdefTag.NOT_FOUND, s.process(apdu("00 A4 04 00 07 A0000000041010 00"))); // a payment card's AID
        assertArrayEquals(NdefTag.OK, s.process(apdu("00 A4 04 00 07 D2760000850101 00")));
        assertArrayEquals(NdefTag.NOT_FOUND, s.process(apdu("00 A4 00 0C 02 E105")));
        assertArrayEquals(NdefTag.OK, s.process(apdu("00 A4 00 0C 02 E104")));
        assertArrayEquals(NdefTag.NOT_ALLOWED, s.process(apdu("00 D6 0000 02 0000")));
        assertArrayEquals(NdefTag.WRONG_OFFSET, s.process(apdu("00 B0 7F00 10")));
        assertArrayEquals(NdefTag.UNSUPPORTED, s.process(apdu("80 CA 9F7F 00")));
    }

    @Test(expected = IllegalArgumentException.class)
    public void rejectsLinksTooLongForTheTag() {
        StringBuilder s = new StringBuilder("https://aurex.dpdns.org/pay/@amina?note=");
        for (int i = 0; i < 1100; i++) s.append('x');
        new NdefTag(s.toString());
    }
}
