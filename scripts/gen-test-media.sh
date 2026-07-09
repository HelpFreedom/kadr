#!/bin/bash
# Canonical /tmp/kadr-test media for the older e2e suites (e2e..e2e17).
# The newer suites (e2e19+) generate their own media and may overwrite
# b.mp4 with a shorter variant — re-run this script before the old ones.
set -e
mkdir -p /tmp/kadr-test
cd /tmp/kadr-test
ffmpeg -v error -f lavfi -i "testsrc2=s=1280x720:r=30:d=6" \
  -f lavfi -i "sine=frequency=440:duration=6" \
  -c:v libx264 -crf 20 -pix_fmt yuv420p -c:a aac -shortest \
  -movflags +faststart -y a.mp4
ffmpeg -v error -f lavfi -i "smptebars=s=640x360:r=30:d=4" \
  -c:v libx264 -crf 18 -pix_fmt yuv420p -movflags +faststart -y b.mp4
ffmpeg -v error -f lavfi -i "sine=frequency=330:duration=8" \
  -codec:a libmp3lame -qscale:a 4 -y music.mp3
ffmpeg -v error -f lavfi -i "testsrc2=s=1280x720:r=30:d=8" \
  -f lavfi -i "sine=frequency=550:duration=8" \
  -c:v libx264 -crf 20 -pix_fmt yuv420p -c:a aac -shortest \
  -movflags +faststart -y hd.mp4
echo "test media ready in /tmp/kadr-test"
