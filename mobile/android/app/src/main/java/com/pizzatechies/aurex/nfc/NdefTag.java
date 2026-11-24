package com.pizzatechies.aurex.nfc;

import java.nio.charset.StandardCharsets;
import java.util.Arrays;

/**
 * An NFC Forum Type 4 Tag that holds one link, answered over ISO 7816-4 commands. Android's host
 * card emulation hands each command from the other phone to {@link Session#process}, so a phone
 * running Aurex looks like an ordinary NFC sticker: any Android phone or iPhone that touches it reads
 * the pay link, with nothing installed. The tag is read-only.
 */
public final class NdefTag {
    /** The NDEF Tag Application's name, which readers select first. */
    static final byte[] AID = hex("D2760000850101");
    static final byte[] CC_FILE_ID = {(byte) 0xE1, 0x03};
    static final byte[] NDEF_FILE_ID = {(byte) 0xE1, 0x04};

    static final byte[] OK = {(byte) 0x90, 0x00};
    static final byte[] NOT_FOUND = {(byte) 0x6A, (byte) 0x82};
    static final byte[] WRONG_OFFSET = {(byte) 0x6B, 0x00};
    static final byte[] NOT_ALLOWED = {(byte) 0x69, (byte) 0x82};
    static final byte[] UNSUPPORTED = {(byte) 0x6D, 0x00};
    static final byte[] WRONG_LENGTH = {(byte) 0x67, 0x00};

    /** Largest answer we send per READ BINARY (the reader may ask for less). */
    static final int MAX_READ = 0xFB;
    static final int MAX_NDEF_FILE = 0x0400;

    private final byte[] capabilityContainer;
    private final byte[] ndefFile;

    public NdefTag(String url) {
        byte[] message = uriMessage(url);
        if (message.length + 2 > MAX_NDEF_FILE) throw new IllegalArgumentException("Link too long for an NFC tag");
        ndefFile = new byte[message.length + 2];
        ndefFile[0] = (byte) (message.length >> 8);
        ndefFile[1] = (byte) message.length;
        System.arraycopy(message, 0, ndefFile, 2, message.length);
        capabilityContainer = new byte[] {
            0x00, 0x0F,                          // CCLEN: 15 bytes
            0x20,                                // mapping version 2.0
            0x00, (byte) MAX_READ,               // MLe: most bytes per read
            0x00, (byte) 0xFF,                   // MLc: most bytes per write (writes are refused anyway)
            0x04, 0x06,                          // NDEF file control TLV
            NDEF_FILE_ID[0], NDEF_FILE_ID[1],
            (byte) (MAX_NDEF_FILE >> 8), (byte) MAX_NDEF_FILE,
            0x00,                                // read access: anyone
            (byte) 0xFF,                         // write access: nobody
        };
    }

    public Session newSession() {
        return new Session();
    }

    /** One tap: which application and file the reader has selected so far. */
    public final class Session {
        private boolean appSelected;
        private byte[] file;

        public byte[] process(byte[] apdu) {
            if (apdu == null || apdu.length < 4) return WRONG_LENGTH;
            int cla = apdu[0] & 0xFF, ins = apdu[1] & 0xFF, p1 = apdu[2] & 0xFF, p2 = apdu[3] & 0xFF;
            if (cla != 0x00) return UNSUPPORTED;
            switch (ins) {
                case 0xA4: return select(apdu, p1, p2);
                case 0xB0: return read(apdu, p1, p2);
                case 0xD6: return NOT_ALLOWED; // UPDATE BINARY: the tag is read-only
                default: return UNSUPPORTED;
            }
        }

        private byte[] select(byte[] apdu, int p1, int p2) {
            if (apdu.length < 5) return WRONG_LENGTH;
            int lc = apdu[4] & 0xFF;
            if (apdu.length < 5 + lc) return WRONG_LENGTH;
            byte[] data = Arrays.copyOfRange(apdu, 5, 5 + lc);
            if (p1 == 0x04) { // select by name
                appSelected = Arrays.equals(data, AID);
                file = null;
                return appSelected ? OK : NOT_FOUND;
            }
            if (p1 == 0x00 && appSelected) { // select a file by its identifier
                if (Arrays.equals(data, CC_FILE_ID)) { file = capabilityContainer; return OK; }
                if (Arrays.equals(data, NDEF_FILE_ID)) { file = ndefFile; return OK; }
            }
            return NOT_FOUND;
        }

        private byte[] read(byte[] apdu, int p1, int p2) {
            if (file == null) return NOT_FOUND;
            int offset = (p1 << 8) | p2;
            int le = apdu.length >= 5 ? apdu[apdu.length - 1] & 0xFF : 0;
            if (le == 0) le = 256;
            if (offset > file.length) return WRONG_OFFSET;
            int n = Math.min(Math.min(le, MAX_READ), file.length - offset);
            byte[] out = new byte[n + 2];
            System.arraycopy(file, offset, out, 0, n);
            out[n] = OK[0];
            out[n + 1] = OK[1];
            return out;
        }
    }

    // ---------------------------------------------------------------------------------------------
    // NDEF encoding: one well-known "U" (URI) record.
    // ---------------------------------------------------------------------------------------------
    private static final String[] PREFIXES = {"", "http://www.", "https://www.", "http://", "https://"};

    static byte[] uriMessage(String url) {
        // URI identifier codes from the NFC Forum URI record type; the longest matching prefix wins.
        int code = url.startsWith("https://www.") ? 2 : url.startsWith("http://www.") ? 1 : url.startsWith("https://") ? 4 : url.startsWith("http://") ? 3 : 0;
        byte[] rest = url.substring(PREFIXES[code].length()).getBytes(StandardCharsets.UTF_8);
        int payloadLength = rest.length + 1;
        boolean shortRecord = payloadLength <= 255;
        byte[] out = new byte[(shortRecord ? 4 : 7) + payloadLength];
        int i = 0;
        out[i++] = (byte) (shortRecord ? 0xD1 : 0xC1); // MB, ME, (SR), TNF = well-known
        out[i++] = 0x01;                                 // type length
        if (shortRecord) {
            out[i++] = (byte) payloadLength;
        } else {
            out[i++] = (byte) (payloadLength >> 24);
            out[i++] = (byte) (payloadLength >> 16);
            out[i++] = (byte) (payloadLength >> 8);
            out[i++] = (byte) payloadLength;
        }
        out[i++] = 'U';
        out[i++] = (byte) code;
        System.arraycopy(rest, 0, out, i, rest.length);
        return out;
    }

    static byte[] hex(String s) {
        byte[] out = new byte[s.length() / 2];
        for (int i = 0; i < out.length; i++) out[i] = (byte) Integer.parseInt(s.substring(2 * i, 2 * i + 2), 16);
        return out;
    }
}
