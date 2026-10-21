import subprocess
import os

def convert_to_1080p(input_file, output_file):
    if not os.path.exists(input_file):
        raise FileNotFoundError(f"File not found: {input_file}")

    command = [
        "ffmpeg",
        "-i", input_file,
        "-vf", "scale=1920:1080",
        "-c:a", "copy",   # giữ nguyên audio
        "-y",             # overwrite nếu file tồn tại
        output_file
    ]

    subprocess.run(command, check=True)
    print(f"Converted to 1080p: {output_file}")


# Example
convert_to_1080p("input.mp4", "output_1080p.mp4")