Đây là một worker làm nhiệm 2 nhiệm vụ chính
- quét ADB định kỳ để xem có thiết bị nào cắm vào hoặc rút ra không rồi push event này vào kafka nó phải tự lưu các devices list in mem của nó để nó biết có sự thay đổi khi cắm vào và rút ra các devices 
- Một consumer để processs message từ kafka, nó nhận vào một mục tiêu là string

```
faststream run main:app --workers 4
```